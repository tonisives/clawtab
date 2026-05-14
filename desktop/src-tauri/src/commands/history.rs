use tauri::State;

use crate::history::RunRecord;
use crate::AppState;

#[tauri::command]
pub fn get_history(state: State<AppState>) -> Result<Vec<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    history.get_recent(100)
}

#[tauri::command]
pub fn get_run_detail(state: State<AppState>, id: String) -> Result<Option<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    let mut record = match history.get_by_id(&id)? {
        Some(r) => r,
        None => return Ok(None),
    };

    // Fallback: if DB stdout/stderr are empty (e.g. the run was interrupted
    // before the executor could flush its captured buffers, or the row predates
    // streaming logs), pull the content from the on-disk log file if present.
    if record.stdout.is_empty() && record.stderr.is_empty() {
        if let Some(ref path) = record.log_path {
            if let Ok(content) = std::fs::read_to_string(path) {
                record.stdout = content;
            }
        }
    }

    Ok(Some(record))
}

/// Tail a run's on-disk log starting at `offset` bytes. Used for live viewing
/// of binary jobs while they're still running.
#[tauri::command]
pub fn tail_run_log(
    state: State<AppState>,
    run_id: String,
    offset: u64,
) -> Result<TailChunk, String> {
    let log_path = {
        let h = state.history.lock().unwrap();
        let rec = h
            .get_by_id(&run_id)?
            .ok_or_else(|| format!("Run '{}' not found", run_id))?;
        rec.log_path
    };
    let Some(path) = log_path else {
        return Ok(TailChunk {
            content: String::new(),
            offset,
        });
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return Ok(TailChunk {
            content: String::new(),
            offset,
        });
    };
    let size = metadata.len();
    // File rotated/truncated: start over from 0.
    let start = if offset > size { 0 } else { offset };
    if start >= size {
        return Ok(TailChunk {
            content: String::new(),
            offset: size,
        });
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut file =
        std::fs::File::open(&path).map_err(|e| format!("Failed to open log file: {}", e))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("Failed to seek log file: {}", e))?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read log file: {}", e))?;
    Ok(TailChunk {
        content: String::from_utf8_lossy(&buf).into_owned(),
        offset: size,
    })
}

#[derive(serde::Serialize)]
pub struct TailChunk {
    pub content: String,
    pub offset: u64,
}

#[tauri::command]
pub fn get_job_runs(state: State<AppState>, job_id: String) -> Result<Vec<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    history.get_by_job_id(&job_id, 10)
}

#[tauri::command]
pub fn open_run_log(state: State<AppState>, run_id: String) -> Result<(), String> {
    let record = {
        let history = state.history.lock().unwrap();
        history
            .get_by_id(&run_id)?
            .ok_or_else(|| format!("Run '{}' not found", run_id))?
    };

    let mut content = format!(
        "Job: {}\nStarted: {}\nFinished: {}\nExit code: {}\nTrigger: {}\n",
        record.job_id,
        record.started_at,
        record.finished_at.as_deref().unwrap_or("(running)"),
        record
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "(none)".to_string()),
        record.trigger,
    );

    if !record.stdout.is_empty() {
        content.push_str("\n--- stdout ---\n");
        content.push_str(&record.stdout);
    }
    if !record.stderr.is_empty() {
        content.push_str("\n--- stderr ---\n");
        content.push_str(&record.stderr);
    }

    // Write to a temp file
    let tmp_dir = std::env::temp_dir().join("clawtab-logs");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create log dir: {}", e))?;
    let file_path = tmp_dir.join(format!("{}.log", run_id));
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write log file: {}", e))?;

    let preferred_editor = {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    };

    let file_path_str = file_path.display().to_string();
    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        editor => {
            let cmd = format!("{} {}", editor, file_path_str);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn delete_run(state: State<AppState>, run_id: String) -> Result<(), String> {
    let history = state.history.lock().unwrap();
    history.delete_by_id(&run_id)
}

#[tauri::command]
pub fn delete_runs(state: State<AppState>, run_ids: Vec<String>) -> Result<(), String> {
    let history = state.history.lock().unwrap();
    history.delete_by_ids(&run_ids)
}

#[tauri::command]
pub fn clear_history(state: State<AppState>) -> Result<(), String> {
    let history = state.history.lock().unwrap();
    history.clear()
}
