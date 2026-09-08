use clawtab_protocol::HostRequest;
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub fn execute(request: HostRequest) -> Result<Value, String> {
    let mut child = Command::new("python3")
        .args(["-c", include_str!("transfer.py")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Python 3 is required for repository transfers")?;
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("transfer input unavailable")?
        .write_all(&bytes)
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "transfer worker failed")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    if !output.status.success() {
        return Err("transfer worker failed".into());
    }
    Ok(value["result"].clone())
}
