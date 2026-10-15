//! Per-user Windows Credential Manager storage; values never enter diagnostics.
use std::collections::HashMap;
use windows_sys::Win32::Security::Credentials::*;

const PREFIX: &str = "ClawTab/";
pub struct KeychainBackend {
    cache: HashMap<String, String>,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

impl KeychainBackend {
    pub fn new() -> Self {
        let mut store = Self {
            cache: HashMap::new(),
        };
        store.reload();
        store
    }
    pub fn get(&self, key: &str) -> Option<&String> {
        self.cache.get(key)
    }
    pub fn list_keys(&self) -> Vec<String> {
        self.cache.keys().cloned().collect()
    }
    pub fn reload(&mut self) {
        self.cache.clear();
        let filter = wide(&format!("{PREFIX}*"));
        let mut count = 0;
        let mut credentials = std::ptr::null_mut();
        if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut credentials) } == 0 {
            return;
        }
        for index in 0..count {
            let credential = unsafe { &**credentials.add(index as usize) };
            let mut len = 0;
            while unsafe { *credential.TargetName.add(len) } != 0 {
                len += 1;
            }
            let name = String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(credential.TargetName, len)
            });
            let value = if credential.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                unsafe {
                    std::slice::from_raw_parts(
                        credential.CredentialBlob,
                        credential.CredentialBlobSize as usize,
                    )
                }
                .to_vec()
            };
            if let (Some(key), Ok(value)) = (name.strip_prefix(PREFIX), String::from_utf8(value)) {
                self.cache.insert(key.into(), value);
            }
        }
        unsafe {
            CredFree(credentials.cast());
        }
    }
    pub fn reload_keys(&mut self, _keys: &[&str]) {
        self.reload();
    }
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        if key.contains('\0') || value.len() > 2560 {
            return Err("credential key or value exceeds Windows limits".into());
        }
        let mut target = wide(&format!("{PREFIX}{key}"));
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_mut_ptr();
        credential.CredentialBlobSize = value.len() as u32;
        credential.CredentialBlob = value.as_ptr().cast_mut();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err("Windows Credential Manager could not save the credential".into());
        }
        self.cache.insert(key.into(), value.into());
        Ok(())
    }
    pub fn delete(&mut self, key: &str) -> Result<(), String> {
        let target = wide(&format!("{PREFIX}{key}"));
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
            && std::io::Error::last_os_error().raw_os_error() != Some(1168)
        {
            return Err("Windows Credential Manager could not remove the credential".into());
        }
        self.cache.remove(key);
        Ok(())
    }
}
