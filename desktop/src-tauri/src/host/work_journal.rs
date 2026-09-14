use clawtab_protocol::JournalQuery;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const PAGE_SIZE: usize = 25;
const MAX_PAGES: usize = 40;
const APPROVED_FIELDS: &[&str] = &[
    "id",
    "revision",
    "source_ref",
    "source_id",
    "project",
    "occurred_at",
    "author",
    "is_self",
    "kind",
    "status",
    "text",
    "quote",
];

pub async fn context(query: &JournalQuery) -> Result<Value, String> {
    query.validate()?;
    tokio::time::timeout(std::time::Duration::from_secs(4), request(query))
        .await
        .map_err(|_| "Journal query timed out".to_owned())?
}

async fn request(query: &JournalQuery) -> Result<Value, String> {
    let value = request_value(json!({"action":"context","query":query})).await?;
    validate_context(value)
}

async fn request_value(request: Value) -> Result<Value, String> {
    let path = std::env::var_os("WORK_JOURNAL_SOCKET")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|p| p.join("Work Journal/control.sock")))
        .ok_or("Journal socket directory unavailable")?;
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|_| "Work Journal service is unavailable".to_owned())?;
    let (reader, mut writer) = stream.into_split();
    let body = format!("{request}\n");
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
    if value["ok"] != true {
        return Err("Journal rejected the approved-only request".into());
    }
    Ok(value["data"].clone())
}

fn validate_context(value: Value) -> Result<Value, String> {
    if value["version"] != 1 {
        return Err("Journal unavailable or unsupported protocol version".into());
    }
    for key in ["facts", "writing_examples"] {
        let items = value[key].as_array().ok_or("Malformed journal context")?;
        if items.iter().any(|item| item["status"] != "approved") {
            return Err("Journal returned unapproved material".into());
        }
    }
    Ok(value)
}

pub async fn approved_context(days: u32) -> Result<Value, String> {
    if !(1..=30).contains(&days) {
        return Err("Journal context days must be between 1 and 30".into());
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(6),
        approved_context_inner(days),
    )
    .await
    .map_err(|_| "Approved journal export timed out".to_owned())?
}

async fn approved_context_inner(days: u32) -> Result<Value, String> {
    let mut rows = HashMap::<String, Value>::new();
    for page in 0..MAX_PAGES {
        let data = request_value(json!({
            "action":"timeline",
            "status":"approved",
            "search":null,
            "project":null,
            "kind":null,
            "offset":page * PAGE_SIZE,
        }))
        .await?;
        let batch = data
            .as_array()
            .ok_or("Unexpected journal timeline response")?;
        if batch.len() > PAGE_SIZE {
            return Err("Unexpected journal timeline response".into());
        }
        for item in batch {
            let id = item["id"]
                .as_str()
                .ok_or("Unexpected journal item response")?;
            let revision = item["revision"].as_u64().unwrap_or(0);
            let replace = rows
                .get(id)
                .is_none_or(|old| revision > old["revision"].as_u64().unwrap_or(0));
            if replace {
                rows.insert(id.to_owned(), item.clone());
            }
        }
        if batch.len() < PAGE_SIZE {
            return select_approved_context(rows.into_values().collect(), days, chrono::Utc::now());
        }
    }
    Err("Approved journal exceeds the bounded scan".into())
}

fn select_approved_context(
    items: Vec<Value>,
    days: u32,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Value, String> {
    let cutoff = now - chrono::Duration::days(i64::from(days));
    let mut facts = Vec::new();
    let mut writing = Vec::new();
    for item in items {
        let Some(occurred_at) = item["occurred_at"].as_str() else {
            continue;
        };
        let Ok(occurred_at) = chrono::DateTime::parse_from_rfc3339(occurred_at) else {
            continue;
        };
        let occurred_at = occurred_at.with_timezone(&chrono::Utc);
        if item["status"] != "approved" || occurred_at > now {
            continue;
        }
        if item["source_id"]
            .as_str()
            .is_some_and(|source| source.starts_with("screen:"))
        {
            continue;
        }
        let mut selected = serde_json::Map::new();
        for field in APPROVED_FIELDS {
            if let Some(value) = item.get(*field) {
                selected.insert((*field).to_owned(), value.clone());
            }
        }
        let selected = Value::Object(selected);
        match item["kind"].as_str() {
            Some("fact") if occurred_at >= cutoff => facts.push((occurred_at, selected)),
            Some("writing") if item["is_self"] == true => writing.push((occurred_at, selected)),
            _ => {}
        }
    }
    facts.sort_by_key(|(occurred_at, _)| std::cmp::Reverse(*occurred_at));
    writing.sort_by_key(|(occurred_at, _)| std::cmp::Reverse(*occurred_at));
    Ok(json!({
        "version":1,
        "origin":"local-work-journal-approved-timeline-via-clawtab",
        "checked_at":now.to_rfc3339(),
        "window_days":days,
        "facts":facts.into_iter().map(|(_, item)| item).collect::<Vec<_>>(),
        "writing_examples":writing.into_iter().take(6).map(|(_, item)| item).collect::<Vec<_>>(),
        "instruction":"Private research only. Non-self facts require attribution. Journal approval is not approval to publish a blog post.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn item(id: &str, kind: &str, status: &str, occurred_at: &str) -> Value {
        json!({
            "id":id,
            "revision":2,
            "source_ref":format!("fixture:{id}"),
            "source_id":"git:fixture",
            "project":"journal",
            "occurred_at":occurred_at,
            "author":"self",
            "is_self":true,
            "kind":kind,
            "status":status,
            "text":format!("context {id}"),
            "private_field":"must not leave the daemon",
        })
    }

    #[test]
    fn approved_export_is_bounded_filtered_and_field_limited() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 9, 14, 12, 0, 0).unwrap();
        let mut screen = item("screen", "fact", "approved", "2026-09-14T10:00:00Z");
        screen["source_id"] = json!("screen:fixture");
        let context = select_approved_context(
            vec![
                item("recent", "fact", "approved", "2026-09-13T10:00:00Z"),
                item("old", "fact", "approved", "2026-08-01T10:00:00Z"),
                item("private", "fact", "private", "2026-09-13T10:00:00Z"),
                item("writing", "writing", "approved", "2026-01-01T10:00:00Z"),
                screen,
            ],
            7,
            now,
        )
        .unwrap();

        assert_eq!(context["facts"].as_array().unwrap().len(), 1);
        assert_eq!(context["facts"][0]["id"], "recent");
        assert!(context["facts"][0].get("private_field").is_none());
        assert_eq!(context["writing_examples"][0]["id"], "writing");
        assert_eq!(context["window_days"], 7);
    }
}
