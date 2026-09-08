//! A persisted claim prevents a retry from executing a mutation twice, even if
//! the daemon crashes between executing it and writing its acknowledgement.
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

pub enum Claim {
    New(PathBuf),
    Existing(Value),
}
pub fn claim(id: &str, request: &Value) -> Result<Claim, String> {
    let directory = super::operations::directory(id)?;
    claim_in(directory, request)
}
fn claim_in(directory: PathBuf, request: &Value) -> Result<Claim, String> {
    let mut canonical = request.clone();
    if let Some(object) = canonical.as_object_mut() {
        object.remove("id");
        object.remove("operation_id");
    }
    let path = directory.join("launch-request.json");
    match OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(canonical.to_string().as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            Ok(Claim::New(directory.join("launch-result.json")))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let original: Value =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if original != canonical {
                return Err("operation ID was used for another request".into());
            }
            let response=std::fs::read(directory.join("launch-result.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()).unwrap_or_else(||json!({"type":"error","code":"OPERATION_PENDING","message":"Operation was already accepted; inspect host state before starting another"}));
            Ok(Claim::Existing(response))
        }
        Err(e) => Err(e.to_string()),
    }
}
pub fn complete(path: &std::path::Path, response: &str) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(response.as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_ack_does_not_launch_twice_and_completed_result_replays() {
        let dir = tempfile::tempdir().unwrap();
        let request = json!({"id":"transport-one","type":"run_agent","prompt":"fixture"});
        let Claim::New(result) = claim_in(dir.path().into(), &request).unwrap() else {
            panic!("first claim must be new")
        };
        let retry = json!({"id":"transport-two","type":"run_agent","prompt":"fixture"});
        let Claim::Existing(pending) = claim_in(dir.path().into(), &retry).unwrap() else {
            panic!("duplicate launch")
        };
        assert_eq!(pending["code"], "OPERATION_PENDING");
        complete(&result, &json!({"success":true,"pane_id":"%9"}).to_string()).unwrap();
        let Claim::Existing(saved) = claim_in(dir.path().into(), &retry).unwrap() else {
            panic!("duplicate launch")
        };
        assert_eq!(saved["pane_id"], "%9");
        assert!(claim_in(
            dir.path().into(),
            &json!({"type":"run_agent","prompt":"changed"})
        )
        .is_err());
    }
}
