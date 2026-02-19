use crate::aerospace;

#[tauri::command]
pub fn aerospace_available() -> bool {
    aerospace::is_available()
}

#[tauri::command]
pub fn list_aerospace_workspaces() -> Vec<aerospace::AerospaceWorkspace> {
    aerospace::list_workspaces()
}
