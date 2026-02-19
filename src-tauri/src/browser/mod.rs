#[allow(dead_code)]
pub mod applescript;

use std::path::PathBuf;

/// Get the browser session directory for a job.
/// Sessions are stored at `~/.config/clawdtab/browser-sessions/<job_name>/`.
pub fn session_dir(job_name: &str) -> PathBuf {
    crate::config::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("browser-sessions")
        .join(job_name)
}

/// Check if a saved auth session exists for the job.
pub fn has_session(job_name: &str) -> bool {
    session_dir(job_name).join("auth.json").exists()
}

/// Clear the saved auth session for a job.
pub fn clear_session(job_name: &str) -> Result<(), String> {
    let auth_path = session_dir(job_name).join("auth.json");
    if auth_path.exists() {
        std::fs::remove_file(&auth_path)
            .map_err(|e| format!("Failed to remove auth.json: {}", e))?;
    }
    Ok(())
}

/// Get the root browser-sessions directory (shared node_modules live here).
fn browser_sessions_root() -> PathBuf {
    crate::config::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("browser-sessions")
}

/// Ensure playwright and its browser binaries are installed.
/// Creates a package.json and runs `npm install playwright` + `npx playwright install chromium` if needed.
fn ensure_playwright_installed() -> Result<(), String> {
    let root = browser_sessions_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create browser-sessions dir: {}", e))?;

    let node_modules = root.join("node_modules").join("playwright");
    if !node_modules.exists() {
        let pkg_json = root.join("package.json");
        if !pkg_json.exists() {
            std::fs::write(
                &pkg_json,
                r#"{"private": true, "dependencies": {"playwright": "^1.50.0"}}"#,
            )
            .map_err(|e| format!("Failed to write package.json: {}", e))?;
        }

        log::info!("Installing playwright in {:?}...", root);
        let output = std::process::Command::new("npm")
            .args(["install"])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("Failed to run npm install: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm install playwright failed: {}", stderr));
        }
    }

    // Check if chromium browser binary is downloaded
    // Playwright stores browsers in ~/Library/Caches/ms-playwright/ on macOS
    let cache_dir = dirs::home_dir()
        .map(|h| h.join("Library/Caches/ms-playwright"))
        .unwrap_or_default();
    let has_chromium = cache_dir.exists()
        && std::fs::read_dir(&cache_dir)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().starts_with("chromium"))
            })
            .unwrap_or(false);

    if !has_chromium {
        log::info!("Downloading chromium for playwright...");
        let output = std::process::Command::new("npx")
            .args(["playwright", "install", "chromium"])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("Failed to run playwright install: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("playwright install chromium failed: {}", stderr));
        }
    }

    Ok(())
}

/// Launch an interactive browser session so the user can log in.
/// Uses Playwright's persistent context with `headless: false`.
/// Auth state (cookies, localStorage) is saved to `auth.json` in the session dir.
pub fn launch_auth_session(url: &str, job_name: &str) -> Result<(), String> {
    ensure_playwright_installed()?;

    let sess_dir = session_dir(job_name);
    std::fs::create_dir_all(&sess_dir)
        .map_err(|e| format!("Failed to create session dir: {}", e))?;

    let auth_path = sess_dir.join("auth.json");
    let user_data_dir = sess_dir.join("user-data");
    let root = browser_sessions_root();

    let script = format!(
        r#"const {{ chromium }} = require('playwright');
(async () => {{
  const context = await chromium.launchPersistentContext({user_data_dir}, {{
    headless: false,
    viewport: {{ width: 1280, height: 900 }},
  }});
  const page = context.pages()[0] || await context.newPage();
  await page.goto({url});
  console.log('Browser opened. Log in, then close the browser window to save session.');
  // Periodically save state while the browser is open
  const saveInterval = setInterval(async () => {{
    try {{
      await context.storageState({{ path: {auth_path} }});
    }} catch (e) {{
      // Context may be closing, ignore
    }}
  }}, 5000);
  await new Promise(resolve => context.on('close', resolve));
  clearInterval(saveInterval);
  try {{
    await context.storageState({{ path: {auth_path} }});
  }} catch (e) {{
    console.log('Final save skipped (browser already closed). Session was saved periodically.');
  }}
  console.log('Session saved.');
}})();
"#,
        user_data_dir = serde_json::to_string(&user_data_dir.to_string_lossy().as_ref())
            .unwrap_or_default(),
        url = serde_json::to_string(url).unwrap_or_default(),
        auth_path = serde_json::to_string(&auth_path.to_string_lossy().as_ref())
            .unwrap_or_default(),
    );

    let tmp_script = sess_dir.join("_auth_launch.js");
    std::fs::write(&tmp_script, &script)
        .map_err(|e| format!("Failed to write auth script: {}", e))?;

    let log_path = sess_dir.join("_auth_launch.log");
    let log_file = std::fs::File::create(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;
    let stderr_file = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log file: {}", e))?;

    // Run from the browser-sessions root so require('playwright') resolves
    std::process::Command::new("node")
        .arg(&tmp_script)
        .current_dir(&root)
        .stdout(log_file)
        .stderr(stderr_file)
        .spawn()
        .map_err(|e| format!("Failed to launch auth browser: {}", e))?;

    Ok(())
}
