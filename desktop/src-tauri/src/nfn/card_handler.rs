use serde_json::Value;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

/// Handlers are local settings, never executable code supplied by a message.
pub(super) async fn run(command: &[String], payload: &Value) -> Result<(), String> {
    let executable = command.first().ok_or("Missing card handler executable")?;
    let mut child = tokio::process::Command::new(executable)
        .args(&command[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start card handler")?;
    let input = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(28), async {
        let mut stdin = child.stdin.take().ok_or("Card handler input unavailable")?;
        stdin
            .write_all(&input)
            .await
            .map_err(|_| "Could not send card to handler")?;
        drop(stdin);
        let status = child
            .wait()
            .await
            .map_err(|_| "Could not wait for card handler")?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not record handled card; try again")
        }
    })
    .await
    .map_err(|_| "Card handler timed out; try again")?;
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handler_receives_json_and_propagates_failure() {
        let command = vec![
            "/bin/sh".into(),
            "-c".into(),
            "test \"$(cat)\" = '{\"card\":\"reply\"}'".into(),
        ];
        run(&command, &serde_json::json!({"card":"reply"}))
            .await
            .unwrap();
        assert!(run(&["/usr/bin/false".into()], &Value::Null).await.is_err());
    }
}
