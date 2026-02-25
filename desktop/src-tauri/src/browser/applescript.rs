use std::process::Command;

/// Open a URL in a macOS browser application.
pub fn open_url(browser: &str, url: &str) -> Result<(), String> {
    Command::new("open")
        .args(["-a", browser, url])
        .output()
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    Ok(())
}

/// Get the text content of the active tab in a Chromium-based browser.
pub fn get_page_content(browser: &str) -> Result<String, String> {
    let app_name = resolve_app_name(browser);
    let script = format!(
        r#"tell application "{}"
  set pageText to execute active tab of front window javascript "document.body.innerText"
  return pageText
end tell"#,
        app_name
    );

    run_osascript(&script)
}

/// Take a screenshot of the frontmost browser window using screencapture.
pub fn screenshot_window(output_path: &str) -> Result<(), String> {
    // Use screencapture to capture the frontmost window
    let output = Command::new("screencapture")
        .args(["-l", "$(osascript -e 'tell application \"System Events\" to return id of first window of first process whose frontmost is true')", "-o", output_path])
        .output()
        .map_err(|e| format!("screencapture failed: {}", e))?;

    if !output.status.success() {
        // Fallback: capture the frontmost window interactively
        let output2 = Command::new("screencapture")
            .args(["-w", "-o", output_path])
            .output()
            .map_err(|e| format!("screencapture fallback failed: {}", e))?;
        if !output2.status.success() {
            return Err("Failed to capture screenshot".to_string());
        }
    }

    Ok(())
}

/// Execute JavaScript in the active tab of a Chromium-based browser.
pub fn execute_js(browser: &str, js: &str) -> Result<String, String> {
    let app_name = resolve_app_name(browser);
    let escaped_js = js.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"tell application "{}"
  set result to execute active tab of front window javascript "{}"
  return result
end tell"#,
        app_name, escaped_js
    );

    run_osascript(&script)
}

/// Get the URL of the active tab.
pub fn get_active_url(browser: &str) -> Result<String, String> {
    let app_name = resolve_app_name(browser);
    let script = format!(
        r#"tell application "{}"
  return URL of active tab of front window
end tell"#,
        app_name
    );

    run_osascript(&script)
}

fn run_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript failed: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("AppleScript error: {}", stderr))
    }
}

/// Map short names to full macOS app names.
fn resolve_app_name(browser: &str) -> &str {
    match browser.to_lowercase().as_str() {
        "brave" => "Brave Browser",
        "chrome" => "Google Chrome",
        "safari" => "Safari",
        "firefox" => "Firefox",
        "arc" => "Arc",
        _ => browser,
    }
}
