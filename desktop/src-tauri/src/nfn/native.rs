use serde_json::Value;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{c_char, CStr, CString},
        sync::OnceLock,
    };
    static RUNTIME: OnceLock<tokio::runtime::Handle> = OnceLock::new();
    extern "C" {
        fn clawtab_nfn_run(
            html: *const c_char,
            icon: *const u8,
            icon_len: usize,
            callback: extern "C" fn(*const c_char),
        ) -> i32;
        fn clawtab_nfn_push(value: *const c_char);
        fn clawtab_nfn_stop();
        fn clawtab_nfn_activate(pid: u32);
        fn clawtab_nfn_activate_clawtab();
    }
    extern "C" fn receive(raw: *const c_char) {
        if raw.is_null() {
            return;
        }
        let Ok(value) =
            serde_json::from_str::<Value>(&unsafe { CStr::from_ptr(raw) }.to_string_lossy())
        else {
            return;
        };
        let Some(runtime) = RUNTIME.get() else {
            return;
        };
        runtime.spawn(async move {
            let Some(service) = super::super::service().cloned() else {
                return;
            };
            let token = value.get("token").cloned().unwrap_or(Value::Null);
            let raw_command = value.get("command").cloned().unwrap_or(value.clone());
            let result = if raw_command["op"] == "media" {
                super::super::remote::execute(raw_command).await
            } else {
                match serde_json::from_value(raw_command) {
                    Ok(command) => service.execute(command).await,
                    Err(e) => {
                        log::warn!("[nfn] Invalid macOS notification command: {e}");
                        Err(e.to_string())
                    }
                }
            };
            let response = match result {
                Ok(value) => serde_json::json!({"type":"response","token":token,"value":value}),
                Err(error) => serde_json::json!({"type":"response","token":token,"error":error}),
            };
            push(response);
        });
    }
    pub fn run(runtime: tokio::runtime::Handle) -> bool {
        let _ = RUNTIME.set(runtime);
        let html = super::html();
        let Ok(html) = CString::new(html) else {
            return false;
        };
        let icon = include_bytes!("../../icons/tray-icon.png");
        unsafe { clawtab_nfn_run(html.as_ptr(), icon.as_ptr(), icon.len(), receive) == 0 }
    }
    pub fn push(value: Value) {
        if let Ok(json) = CString::new(value.to_string()) {
            unsafe {
                clawtab_nfn_push(json.as_ptr());
            }
        }
    }
    pub fn stop() {
        unsafe {
            clawtab_nfn_stop();
        }
    }
    pub fn activate(pid: u32) {
        unsafe {
            clawtab_nfn_activate(pid);
        }
    }
    pub fn activate_clawtab() {
        unsafe {
            clawtab_nfn_activate_clawtab();
        }
    }
}

pub fn html() -> String {
    include_str!("../../../../shared/src/nfn/surface.html")
        .replace(
            "/* NFN_CSS */",
            include_str!("../../../../shared/src/nfn/surface.css"),
        )
        .replace(
            "/* NFN_JS */",
            include_str!("../../../../shared/src/nfn/surface.js"),
        )
}

#[cfg(target_os = "macos")]
pub use macos::{activate, activate_clawtab, push, run, stop};
#[cfg(not(target_os = "macos"))]
pub fn run(_: tokio::runtime::Handle) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn push(_: Value) {}
#[cfg(not(target_os = "macos"))]
pub fn stop() {}
#[cfg(not(target_os = "macos"))]
pub fn activate(_: u32) {}
#[cfg(not(target_os = "macos"))]
pub fn activate_clawtab() {}
