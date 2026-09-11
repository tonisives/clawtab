use clawtab_protocol::JournalQuery;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub async fn context(query: &JournalQuery) -> Result<Value, String> {
    query.validate()?;
    tokio::time::timeout(std::time::Duration::from_secs(4), request(query))
        .await
        .map_err(|_| "Journal query timed out".to_owned())?
}

async fn request(query: &JournalQuery) -> Result<Value, String> {
    let path = std::env::var_os("WORK_JOURNAL_SOCKET")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|p| p.join("Work Journal/control.sock")))
        .ok_or("Journal socket directory unavailable")?;
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|_| "Work Journal service is unavailable".to_owned())?;
    let (reader, mut writer) = stream.into_split();
    let body = format!("{}\n", json!({"action":"context","query":query}));
    writer
        .write_all(body.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(reader.take(512 * 1024))
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    if !line.ends_with('\n') {
        return Err("Incomplete journal response".into());
    }
    let value: Value =
        serde_json::from_str(&line).map_err(|_| "Invalid journal response".to_owned())?;
    if value["ok"] != true || value["data"]["version"] != 1 {
        return Err("Journal unavailable or unsupported protocol version".into());
    }
    for key in ["facts", "writing_examples"] {
        let items = value["data"][key]
            .as_array()
            .ok_or("Malformed journal context")?;
        if items.iter().any(|item| item["status"] != "approved") {
            return Err("Journal returned unapproved material".into());
        }
    }
    Ok(value["data"].clone())
}
