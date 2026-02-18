#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cron_manager_lib::run();
}
