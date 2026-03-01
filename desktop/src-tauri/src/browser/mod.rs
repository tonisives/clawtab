use std::path::PathBuf;

/// Get the browser session directory for a job.
/// Sessions are stored at `~/.config/clawtab/browser-sessions/<job_name>/`.
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

/// Check if the playwright node module is installed.
pub fn is_playwright_installed() -> bool {
    browser_sessions_root()
        .join("node_modules")
        .join("playwright")
        .exists()
}

/// Whether the chosen browser needs playwright to download a bundled binary.
/// Native channel browsers (chrome, brave) use the system-installed binary.
fn needs_browser_download(browser: &str) -> bool {
    matches!(browser, "chromium" | "firefox")
}

/// Ensure playwright node module is installed, and download browser binary if needed.
fn ensure_playwright_installed(browser: &str) -> Result<(), String> {
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
            .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
            .output()
            .map_err(|e| format!("Failed to run npm install: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm install playwright failed: {}", stderr));
        }
    }

    if !needs_browser_download(browser) {
        return Ok(());
    }

    // Playwright stores browsers in ~/Library/Caches/ms-playwright/ on macOS
    let cache_dir = dirs::home_dir()
        .map(|h| h.join("Library/Caches/ms-playwright"))
        .unwrap_or_default();

    let browser_prefix = match browser {
        "firefox" => "firefox",
        _ => "chromium",
    };

    let has_binary = cache_dir.exists()
        && std::fs::read_dir(&cache_dir)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().starts_with(browser_prefix))
            })
            .unwrap_or(false);

    if !has_binary {
        log::info!("Downloading {} for playwright...", browser_prefix);
        let output = std::process::Command::new("npx")
            .args(["playwright", "install", browser_prefix])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("Failed to run playwright install: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("playwright install {} failed: {}", browser_prefix, stderr));
        }
    }

    Ok(())
}

/// Build the playwright JS script based on browser choice.
fn build_auth_script(
    browser: &str,
    user_data_dir: &str,
    url: &str,
    auth_path: &str,
) -> String {
    let (require_name, launch_opts) = match browser {
        "chrome" => (
            "chromium",
            r#"{
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
  }"#
            .to_string(),
        ),
        "brave" => (
            "chromium",
            r#"{
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: false,
    viewport: { width: 1280, height: 900 },
  }"#
            .to_string(),
        ),
        "firefox" => (
            "firefox",
            r#"{
    headless: false,
    viewport: { width: 1280, height: 900 },
  }"#
            .to_string(),
        ),
        // "chromium" or fallback
        _ => (
            "chromium",
            r#"{
    headless: false,
    viewport: { width: 1280, height: 900 },
  }"#
            .to_string(),
        ),
    };

    format!(
        r#"const {{ {require_name} }} = require('playwright');
(async () => {{
  const context = await {require_name}.launchPersistentContext({user_data_dir}, {launch_opts});
  const page = context.pages()[0] || await context.newPage();
  await page.goto({url});
  console.log('Browser opened. Log in, then close the browser window to save session.');
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
        require_name = require_name,
        user_data_dir = user_data_dir,
        url = url,
        auth_path = auth_path,
        launch_opts = launch_opts,
    )
}

/// Launch an interactive browser session so the user can log in.
/// Uses Playwright's persistent context with `headless: false`.
/// Auth state (cookies, localStorage) is saved to `auth.json` in the session dir.
pub fn launch_auth_session(url: &str, job_name: &str, browser: &str) -> Result<(), String> {
    ensure_playwright_installed(browser)?;

    let sess_dir = session_dir(job_name);
    std::fs::create_dir_all(&sess_dir)
        .map_err(|e| format!("Failed to create session dir: {}", e))?;

    let auth_path = sess_dir.join("auth.json");
    let user_data_dir = sess_dir.join("user-data");
    let root = browser_sessions_root();

    let user_data_dir_json =
        serde_json::to_string(&user_data_dir.to_string_lossy().as_ref()).unwrap_or_default();
    let url_json = serde_json::to_string(url).unwrap_or_default();
    let auth_path_json =
        serde_json::to_string(&auth_path.to_string_lossy().as_ref()).unwrap_or_default();

    let script = build_auth_script(browser, &user_data_dir_json, &url_json, &auth_path_json);

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
