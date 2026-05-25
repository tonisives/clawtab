use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead};
use tokio::process::Command;
use tokio::task::JoinHandle;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

pub(super) async fn execute_binary_job(
    job: &Job,
    run_id: &str,
    started_at: &str,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
    stream_log_path: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String), String> {
    let mut cmd = build_command(
        job,
        secrets,
        settings,
        params,
        result_file,
        stream_log_path,
        run_id,
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;
    if let Some(pid) = child.id() {
        super::binary_runtime::register(job, run_id, started_at, pid);
        log::info!(
            "[{}] Started binary job '{}' pid={} pgid={}",
            run_id,
            job.name,
            pid,
            pid
        );
    } else {
        log::warn!("[{}] Binary job '{}' has no child pid", run_id, job.name);
    }

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let log_file = open_stream_log(stream_log_path);
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout_task = stream_to_buf(stdout_pipe, Arc::clone(&stdout_buf), log_file.clone());
    let stderr_task = stream_to_buf(stderr_pipe, Arc::clone(&stderr_buf), log_file.clone());

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for process: {}", e))?;
    super::binary_runtime::unregister(&job.slug);
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let stdout = Arc::try_unwrap(stdout_buf)
        .map(|m| m.into_inner())
        .unwrap_or_default();
    let stderr = Arc::try_unwrap(stderr_buf)
        .map(|m| m.into_inner())
        .unwrap_or_default();

    Ok((status.code(), stdout, stderr))
}

/// Build the tokio Command with env_clear + minimal PATH/HOME passthrough,
/// secrets, job env, trigger params (as CLAWTAB_PARAM_*), and the optional
/// CLAWTAB_RESULT_FILE. Piped stdio is configured so callers can stream.
fn build_command(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
    stream_log_path: Option<&std::path::Path>,
    run_id: &str,
) -> Command {
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
    cmd.env("CLAWTAB_JOB_SLUG", &job.slug);
    cmd.env("CLAWTAB_RUN_ID", run_id);
    if let Some(path) = stream_log_path {
        cmd.env("CLAWTAB_LOG_FILE", path.as_os_str());
    }
    if let Some(job_id) = &job.job_id {
        cmd.env("CLAWTAB_JOB_ID", job_id);
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
    #[cfg(unix)]
    {
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd
}

/// Open the streaming log file in truncate+write mode. Returns None and logs
/// a warning on failure so a missing log doesn't fail the whole run.
/// Writers from the two reader tasks share an Arc<Mutex<File>> so interleaving
/// stays line-coherent.
fn open_stream_log(path: Option<&std::path::Path>) -> Option<Arc<Mutex<std::fs::File>>> {
    let p = path?;
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
}

/// Read `pipe` line-by-line; append each line to `buf` (and to `file` if open)
/// until EOF. Shared by the stdout and stderr readers.
fn stream_to_buf<R>(
    pipe: R,
    buf: Arc<Mutex<String>>,
    file: Option<Arc<Mutex<std::fs::File>>>,
) -> JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(pipe).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            append_line(&buf, file.as_deref(), &line);
        }
    })
}

/// Append a line to the in-memory buffer and (if open) to the shared log file.
/// One lock per line on each side keeps stdout/stderr writes from tearing.
fn append_line(buf: &Mutex<String>, file: Option<&Mutex<std::fs::File>>, line: &str) {
    {
        let mut b = buf.lock();
        b.push_str(line);
        b.push('\n');
    }
    if let Some(f) = file {
        use std::io::Write;
        let mut g = f.lock();
        let _ = g.write_all(line.as_bytes());
        let _ = g.write_all(b"\n");
        let _ = g.flush();
    }
}
