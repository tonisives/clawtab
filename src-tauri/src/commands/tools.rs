use crate::tools;

#[tauri::command]
pub fn detect_tools() -> Vec<tools::ToolInfo> {
    tools::detect_tools()
}
