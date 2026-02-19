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
    history.get_by_id(&id)
}

#[tauri::command]
pub fn get_job_runs(
    state: State<AppState>,
    job_name: String,
) -> Result<Vec<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    history.get_by_job_name(&job_name, 10)
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
        record.job_name,
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
    let tmp_dir = std::env::temp_dir().join("clawdtab-logs");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create log dir: {}", e))?;
    let file_path = tmp_dir.join(format!("{}.log", run_id));
    std::fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to write log file: {}", e))?;

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
pub fn clear_history(state: State<AppState>) -> Result<(), String> {
    let history = state.history.lock().unwrap();
    history.clear()
}
