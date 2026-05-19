// Force the settings (main GUI) NSWindow to advertise itself as a standard,
// managed, tileable window so tiling WMs like Aerospace/yabai pick it up.
//
// Without this, Tauri's default NSWindow comes back with a styleMask /
// collectionBehavior combination that some tiling WMs classify as a floating
// utility window and refuse to manage.

#![cfg(target_os = "macos")]

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask};
use tauri::Manager;

pub fn make_standard_tileable_window(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }

    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;

        let required_mask = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Miniaturizable
            | NSWindowStyleMask::Resizable;
        let current_mask: NSWindowStyleMask = msg_send![ns_window, styleMask];
        let new_mask = current_mask | required_mask;
        if new_mask != current_mask {
            let _: () = msg_send![ns_window, setStyleMask: new_mask];
        }

        let managed_behavior = NSWindowCollectionBehavior::Managed
            | NSWindowCollectionBehavior::ParticipatesInCycle
            | NSWindowCollectionBehavior::FullScreenPrimary;
        let _: () = msg_send![ns_window, setCollectionBehavior: managed_behavior];

        let _: () = msg_send![ns_window, setMovable: true];
    }
}
