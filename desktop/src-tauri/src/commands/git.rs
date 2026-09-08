pub use crate::host::git::GitRepository;

#[tauri::command]
pub async fn get_git_repository(cwd: String) -> Result<GitRepository, String> {
    crate::host::git::get_git_repository(cwd).await
}
