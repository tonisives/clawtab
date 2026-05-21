use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

use tokio::process::Command;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

pub(super) async fn execute_binary_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
    stream_log_path: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String), String> {
    let work_dir = job.work_dir.clone().unwrap_or_else(|| {
        let s = settings.lock();
        s.default_work_dir.clone()
    });

    let mut cmd = Command::new(&job.path);
    cmd.args(&job.args);
    cmd.env_clear();

    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }

    {
        let sm = secrets.lock();
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                cmd.env(key, value);
            }
        }
    }

    for (k, v) in &job.env {
        cmd.env(k, v);
    }

    if let Some(p) = result_file {
        cmd.env("CLAWTAB_RESULT_FILE", p);
    }

    // Trigger params -> CLAWTAB_PARAM_<UPPER_KEY>. Lets binary jobs accept
    // per-invocation inputs from /v1/triggers/run without needing a Claude
    // agent for templating.
    for (k, v) in params {
        let key = format!("CLAWTAB_PARAM_{}", k.to_ascii_uppercase());
        cmd.env(key, v);
    }

    cmd.current_dir(&work_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Open the streaming log file. Writers from both reader tasks share an
    // Arc<Mutex<File>> so interleaving stays line-coherent; line-based reads
    // mean a single lock per line and no torn writes between stdout/stderr.
    let log_file: Option<Arc<Mutex<std::fs::File>>> = stream_log_path.and_then(|p| {
        match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(p)
        {
            Ok(f) => Some(Arc::new(Mutex::new(f))),
            Err(e) => {
                log::warn!("Failed to open stream log {}: {}", p.display(), e);
                None
            }
        }
    });

    use tokio::io::AsyncBufReadExt;
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout_task = {
        let buf = Arc::clone(&stdout_buf);
        let file = log_file.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout_pipe).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                {
                    let mut b = buf.lock();
                    b.push_str(&line);
                    b.push('\n');
                }
                if let Some(ref f) = file {
                    use std::io::Write;
                    let mut g = f.lock();
                    let _ = g.write_all(line.as_bytes());
                    let _ = g.write_all(b"\n");
                    let _ = g.flush();
                }
            }
        })
    };

    let stderr_task = {
        let buf = Arc::clone(&stderr_buf);
        let file = log_file.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                {
                    let mut b = buf.lock();
                    b.push_str(&line);
                    b.push('\n');
                }
                if let Some(ref f) = file {
                    use std::io::Write;
                    let mut g = f.lock();
                    let _ = g.write_all(line.as_bytes());
                    let _ = g.write_all(b"\n");
                    let _ = g.flush();
                }
            }
        })
    };

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for process: {}", e))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let stdout = Arc::try_unwrap(stdout_buf)
        .map(|m| m.into_inner())
        .unwrap_or_default();
    let stderr = Arc::try_unwrap(stderr_buf)
        .map(|m| m.into_inner())
        .unwrap_or_default();
    let exit_code = status.code();

    Ok((exit_code, stdout, stderr))
}
