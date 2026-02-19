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

/// Launch an interactive browser session so the user can log in.
/// Uses Playwright's persistent context with `headless: false`.
/// Auth state (cookies, localStorage) is saved to `auth.json` in the session dir.
pub fn launch_auth_session(url: &str, job_name: &str) -> Result<(), String> {
    let sess_dir = session_dir(job_name);
    std::fs::create_dir_all(&sess_dir)
        .map_err(|e| format!("Failed to create session dir: {}", e))?;

    let auth_path = sess_dir.join("auth.json");
    let user_data_dir = sess_dir.join("user-data");

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
  // Final save attempt (may fail if context is already gone)
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

    // Write temp script and spawn node
    let tmp_script = sess_dir.join("_auth_launch.js");
    std::fs::write(&tmp_script, &script)
        .map_err(|e| format!("Failed to write auth script: {}", e))?;

    let log_path = sess_dir.join("_auth_launch.log");
    let log_file = std::fs::File::create(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;
    let stderr_file = log_file.try_clone()
        .map_err(|e| format!("Failed to clone log file: {}", e))?;

    std::process::Command::new("node")
        .arg(&tmp_script)
        .stdout(log_file)
        .stderr(stderr_file)
        .spawn()
        .map_err(|e| format!("Failed to launch auth browser: {}. Is Node.js installed with playwright? Try: npm install -g playwright", e))?;

    Ok(())
}
