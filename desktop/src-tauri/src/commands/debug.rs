use crate::debug_spawn::{self, SpawnEventRow, SpawnSummary};

#[tauri::command]
pub fn debug_spawn_list(
    since_ms: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<SpawnEventRow>, String> {
    debug_spawn::list_since(since_ms, limit.unwrap_or(2000))
}

#[tauri::command]
pub fn debug_spawn_summary() -> Result<SpawnSummary, String> {
    debug_spawn::summary()
}

#[tauri::command]
pub fn debug_spawn_clear() -> Result<(), String> {
    debug_spawn::clear()
}
