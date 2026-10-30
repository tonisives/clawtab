use super::{service, NfnCommand, NfnRecord};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};

const MAX_CHUNK: u64 = 256 * 1024;
const MAX_ATTACHMENT: u64 = 128 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum MediaCommand {
    Media {
        id: String,
        index: usize,
        offset: u64,
        length: u64,
    },
}

pub async fn execute(value: Value) -> Result<Value, String> {
    let service = service().ok_or("Message service unavailable")?;
    if value["op"] == "media" {
        let MediaCommand::Media {
            id,
            index,
            offset,
            length,
        } = serde_json::from_value(value).map_err(|error| error.to_string())?;
        let record = service.execute(NfnCommand::Get { id }).await?;
        let record: NfnRecord =
            serde_json::from_value(record).map_err(|error| error.to_string())?;
        return tokio::task::spawn_blocking(move || media_range(&record, index, offset, length))
            .await
            .map_err(|error| error.to_string())?;
    }
    let command: NfnCommand = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if !allowed(&command) {
        return Err("Unsupported remote message operation".into());
    }
    service.execute(command).await
}

fn allowed(command: &NfnCommand) -> bool {
    matches!(
        command,
        NfnCommand::Get { .. }
            | NfnCommand::List { .. }
            | NfnCommand::Respond { .. }
            | NfnCommand::Read { .. }
            | NfnCommand::Dismiss { .. }
            | NfnCommand::KillSession { .. }
            | NfnCommand::Ignore { .. }
            | NfnCommand::Unignore { .. }
            | NfnCommand::IgnoredAgents
            | NfnCommand::Cancel { .. }
            | NfnCommand::Context { .. }
            | NfnCommand::Templates
            | NfnCommand::Todos
            | NfnCommand::TodoRefresh
            | NfnCommand::TodoAdd { .. }
            | NfnCommand::TodoUpdate { .. }
            | NfnCommand::TodoStart { .. }
    )
}

fn media_range(
    record: &NfnRecord,
    index: usize,
    offset: u64,
    length: u64,
) -> Result<Value, String> {
    if length > MAX_CHUNK {
        return Err("Attachment ranges are limited to 256 KiB".into());
    }
    let media = record
        .request
        .media
        .get(index)
        .ok_or("Attachment not found")?;
    let path = std::path::Path::new(&media.src);
    if !path.is_absolute() || !["image", "video"].contains(&media.kind.as_str()) {
        return Err("Attachment is not a local image or video".into());
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Attachment is not a file".into());
    }
    let size = metadata.len();
    if size > MAX_ATTACHMENT {
        return Err("Remote attachments are limited to 128 MiB".into());
    }
    if offset > size {
        return Err("Attachment range starts beyond the file".into());
    }
    let mime = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        _ => return Err("Unsupported attachment format".into()),
    };
    if !mime.starts_with(&format!("{}/", media.kind)) {
        return Err("Attachment format does not match its kind".into());
    }
    let count = length.min(size - offset) as usize;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0; count];
    file.read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({ "mime": mime, "size": size, "offset": offset, "data": STANDARD.encode(bytes), "eof": offset + count as u64 == size }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(path: &std::path::Path) -> NfnRecord {
        serde_json::from_value(json!({
            "id": "review", "request": { "title": "Review", "media": [{"kind":"video","src":path,"alt":"Preview"}] },
            "status":"pending", "created_at":0, "updated_at":0, "read_at":null, "dismissed_at":null,
            "response":null, "error":null, "question_id":null
        })).unwrap()
    }

    #[test]
    fn range_reads_are_bounded_seekable_and_clipped_at_eof() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview.mp4");
        std::fs::write(&path, b"0123456789").unwrap();
        let record = attachment(&path);
        let metadata = media_range(&record, 0, 0, 0).unwrap();
        assert_eq!(metadata["size"], 10);
        assert_eq!(metadata["data"], "");
        let middle = media_range(&record, 0, 3, 4).unwrap();
        assert_eq!(middle["data"], STANDARD.encode(b"3456"));
        assert_eq!(middle["eof"], false);
        let tail = media_range(&record, 0, 8, 4).unwrap();
        assert_eq!(tail["data"], STANDARD.encode(b"89"));
        assert_eq!(tail["eof"], true);
        assert!(media_range(&record, 0, 11, 1).is_err());
        assert!(media_range(&record, 0, 0, MAX_CHUNK + 1).is_err());
        assert!(media_range(&record, 1, 0, 1).is_err());
    }

    #[test]
    fn media_commands_cannot_supply_paths_and_only_use_stored_attachments() {
        assert!(serde_json::from_value::<MediaCommand>(
            json!({"op":"media","id":"review","index":0,"offset":0,"length":5,"path":"/etc/passwd"})
        )
        .is_err());
        let mut record = attachment(std::path::Path::new("relative.mp4"));
        assert!(media_range(&record, 0, 0, 5).is_err());
        record.request.media[0].src = "https://cdn.clawtab.cc/preview.mp4".into();
        assert!(media_range(&record, 0, 0, 5).is_err());
    }

    #[test]
    fn remote_surface_can_read_details_and_templates_without_changing_host_settings() {
        assert!(allowed(&NfnCommand::Context {
            id: "review".into()
        }));
        assert!(allowed(&NfnCommand::Templates));
        assert!(allowed(&NfnCommand::Todos));
        assert!(!allowed(&NfnCommand::TodoLink {
            note: "/tmp/tasks.md".into(),
            agents: None
        }));
        assert!(!allowed(&NfnCommand::SaveSettings {
            patch: json!({"sound":false})
        }));
        assert!(!allowed(&NfnCommand::SaveTemplate { yaml: "x".into() }));
        assert!(!allowed(&NfnCommand::Show));
        assert!(!allowed(&NfnCommand::Platform {
            state: Default::default()
        }));
    }
}
