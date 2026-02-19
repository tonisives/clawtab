use tauri::State;

use crate::telegram::TelegramConfig;
use crate::AppState;

#[tauri::command]
pub fn get_telegram_config(state: State<AppState>) -> Option<TelegramConfig> {
    let settings = state.settings.lock().unwrap();
    settings.telegram.clone()
}

#[tauri::command]
pub fn set_telegram_config(
    state: State<AppState>,
    config: Option<TelegramConfig>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.telegram = config;
    settings.save()
}

#[tauri::command]
pub async fn test_telegram(bot_token: String, chat_id: i64) -> Result<(), String> {
    crate::telegram::test_connection(&bot_token, chat_id).await
}
