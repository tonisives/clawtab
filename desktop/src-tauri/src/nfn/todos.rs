use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Links {
    note: PathBuf,
    agents: Option<PathBuf>,
    spawned: HashMap<String, Value>,
}

#[derive(Clone, Serialize)]
pub struct Todo {
    pub id: String,
    pub text: String,
    pub group: String,
    pub depth: usize,
    pub checked: bool,
    pub agent: Option<Value>,
    #[serde(skip)]
    line: usize,
}

fn config_path() -> Result<PathBuf, String> {
    Ok(crate::config::config_dir()
        .ok_or("Could not find ClawTab configuration")?
        .join("todos.json"))
}
fn load() -> Result<Links, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(Links::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save(links: &Links) -> Result<(), String> {
    let path = config_path()?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    atomic_write(
        &path,
        &serde_json::to_vec_pretty(links).map_err(|e| e.to_string())?,
    )
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("clawtab-{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(&temporary, metadata.permissions()).map_err(|e| e.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn parse(note: &str) -> Vec<Todo> {
    let mut group = String::from("Ungrouped");
    let mut items = Vec::new();
    let mut occurrences = HashMap::new();
    let mut fenced = false;
    let mut frontmatter = false;
    for (line, raw) in note.lines().enumerate() {
        let trimmed = raw.trim_start();
        if line == 0 && trimmed == "---" {
            frontmatter = true;
            continue;
        }
        if frontmatter {
            if trimmed == "---" {
                frontmatter = false;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("## ") {
            group = title.trim().into();
        }
        let Some(rest) = trimmed
            .strip_prefix("- [")
            .or_else(|| trimmed.strip_prefix("* ["))
            .or_else(|| trimmed.strip_prefix("+ ["))
        else {
            continue;
        };
        let bytes = rest.as_bytes();
        if bytes.len() < 3
            || ![b' ', b'x', b'X'].contains(&bytes[0])
            || bytes[1] != b']'
            || bytes[2] != b' '
        {
            continue;
        }
        let text = rest[3..].trim().to_string();
        let depth = raw.len() - trimmed.len();
        let key = (group.clone(), text.clone(), depth);
        let occurrence = occurrences.entry(key.clone()).or_insert(0usize);
        let identity = json!([key.0, key.1, key.2, *occurrence]).to_string();
        let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
        *occurrence += 1;
        items.push(Todo {
            id: format!("todo-{}", &hash[..24]),
            text,
            group: group.clone(),
            depth: depth / 2,
            checked: bytes[0] != b' ',
            agent: None,
            line,
        });
    }
    items
}

fn read_items(links: &Links) -> Result<(String, Vec<Todo>), String> {
    let raw = fs::read_to_string(&links.note)
        .map_err(|e| format!("Could not read {}: {e}", links.note.display()))?;
    let items = parse(&raw);
    Ok((raw, items))
}

fn mappings(links: &Links) -> Vec<Value> {
    let mut agents = Vec::new();
    if let Some(mapping) = links
        .agents
        .as_ref()
        .and_then(|p| fs::read(p).ok())
        .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
    {
        for key in ["tasks", "existing"] {
            agents.extend(mapping[key].as_array().into_iter().flatten().cloned());
        }
    }
    agents
}

pub fn snapshot() -> Value {
    match snapshot_result() {
        Ok(value) => value,
        Err(error) => json!({"items":[],"error":error}),
    }
}
fn snapshot_result() -> Result<Value, String> {
    let links = load()?;
    snapshot_links(&links)
}

fn snapshot_links(links: &Links) -> Result<Value, String> {
    if links.note.as_os_str().is_empty() {
        return Ok(json!({"items":[],"linked":false}));
    }
    let (_, mut items) = read_items(&links)?;
    let agents = mappings(&links);
    let mut parents: Vec<Todo> = Vec::new();
    for item in &mut items {
        while parents
            .last()
            .is_some_and(|parent| parent.group != item.group || parent.depth >= item.depth)
        {
            parents.pop();
        }
        let mapped = agents
            .iter()
            .find(|agent| {
                let group_matches = agent["session"]
                    .as_str()
                    .is_none_or(|group| group == item.group);
                group_matches
                    && (agent["match"]
                        .as_str()
                        .is_some_and(|s| item.text.starts_with(s))
                        || agent["covers"].as_array().is_some_and(|covers| {
                            covers
                                .iter()
                                .any(|s| s.as_str().is_some_and(|s| item.text.starts_with(s)))
                        }))
            })
            .cloned()
            .or_else(|| links.spawned.get(&item.id).cloned())
            .or_else(|| parents.last().and_then(|parent| parent.agent.clone()));
        item.agent = mapped.map(|mut agent| {
            if let Some(status) = agent["status"]
                .as_str()
                .and_then(|p| fs::read(p).ok())
                .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
            {
                agent["state"] = status["state"].clone();
                agent["summary"] = status["summary"].clone();
                agent["blocker"] = status["blocker"].clone();
            }
            agent
        });
        parents.push(item.clone());
    }
    items.sort_by(|a, b| {
        a.group
            .to_lowercase()
            .cmp(&b.group.to_lowercase())
            .then(a.line.cmp(&b.line))
    });
    Ok(json!({"linked":true,"note":links.note,"agents":links.agents,"items":items}))
}

pub fn link(note: String, agents: Option<String>) -> Result<Value, String> {
    let note = fs::canonicalize(note).map_err(|e| e.to_string())?;
    let mut links = load()?;
    if links.note != note {
        links.spawned.clear();
    }
    links.note = note;
    links.agents = agents
        .map(fs::canonicalize)
        .transpose()
        .map_err(|e| e.to_string())?;
    read_items(&links)?;
    save(&links)?;
    snapshot_result()
}

pub fn update(id: &str, checked: bool) -> Result<Value, String> {
    let links = load()?;
    let (before, _) = read_items(&links)?;
    let after = checked_note(&before, id, checked)?;
    write_note(&links.note, &before, &after)?;
    snapshot_result()
}

fn checked_note(before: &str, id: &str, checked: bool) -> Result<String, String> {
    let items = parse(before);
    let item = items
        .iter()
        .find(|item| item.id == id)
        .ok_or("Task changed in the source note; refresh and try again")?;
    let mut lines: Vec<_> = before.split_inclusive('\n').map(str::to_string).collect();
    let marker = lines[item.line].find('[').ok_or("Task checkbox missing")? + 1;
    lines[item.line].replace_range(marker..marker + 1, if checked { "x" } else { " " });
    Ok(lines.concat())
}

fn write_note(path: &Path, before: &str, after: &str) -> Result<(), String> {
    // Read the note again immediately before replacing it, preserving controller edits.
    if fs::read_to_string(path).map_err(|e| e.to_string())? != before {
        return Err("The source note changed; refresh and try again".into());
    }
    atomic_write(path, after.as_bytes())
}

pub fn add(text: &str, group: &str) -> Result<Value, String> {
    let text = text.trim();
    let group = group.trim();
    if text.is_empty()
        || text.len() > 4096
        || text.contains(['\n', '\r'])
        || group.is_empty()
        || group.len() > 128
        || group.contains(['\n', '\r'])
    {
        return Err("Enter a task and group on one line".into());
    }
    let mut links = load()?;
    if links.note.as_os_str().is_empty() {
        links.note = config_path()?.with_file_name("todos.md");
        if !links.note.exists() {
            fs::write(&links.note, "# Tasks\n").map_err(|e| e.to_string())?;
        }
        save(&links)?;
    }
    let (before, _) = read_items(&links)?;
    let after = added_note(&before, text, group);
    write_note(&links.note, &before, &after)?;
    snapshot_result()
}

fn added_note(before: &str, text: &str, group: &str) -> String {
    let items = parse(before);
    if items
        .iter()
        .any(|item| item.text == text && item.group == group)
    {
        return before.into();
    }
    let newline = if before.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = before.split_inclusive('\n').map(str::to_string).collect();
    let heading = format!("## {group}");
    if let Some(start) = lines.iter().position(|line| line.trim() == heading) {
        let end = (start + 1..lines.len())
            .find(|&i| lines[i].starts_with("## "))
            .unwrap_or(lines.len());
        if end > 0 && !lines[end - 1].ends_with('\n') {
            lines[end - 1].push_str(newline);
        }
        lines.insert(end, format!("- [ ] {text}{newline}"));
    } else {
        lines.push(format!(
            "{newline}{heading}{newline}{newline}- [ ] {text}{newline}"
        ));
    }
    lines.concat()
}

pub fn agent(id: &str) -> Result<Value, String> {
    snapshot_result()?["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .and_then(|item| item.get("agent"))
        .filter(|agent| !agent.is_null())
        .cloned()
        .ok_or("No agent linked to this task".into())
}

fn register_agent(path: &Path, agent: &Value) -> Result<(), String> {
    let before = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut mapping: Value = serde_json::from_str(&before).map_err(|e| e.to_string())?;
    if mapping.get("tasks").is_none() {
        mapping["tasks"] = json!([]);
    }
    let tasks = mapping["tasks"]
        .as_array_mut()
        .ok_or("Agent mapping tasks must be an array")?;
    if tasks.iter().any(|task| task["pane"] == agent["pane"]) {
        return Ok(());
    }
    tasks.push(agent.clone());
    let after = serde_json::to_string_pretty(&mapping).map_err(|e| e.to_string())? + "\n";
    write_note(path, &before, &after)
}

pub fn start(id: &str, cwd: &str) -> Result<Value, String> {
    let mut links = load()?;
    let (_, items) = read_items(&links)?;
    let item = items
        .iter()
        .find(|item| item.id == id)
        .ok_or("Task no longer exists")?;
    if item.checked {
        return Err("This task is already complete".into());
    }
    if agent(id).is_ok() {
        return Err("This task already has a linked agent".into());
    }
    let cwd = fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    if !cwd.is_dir() {
        return Err("Choose a working directory".into());
    }
    let session = &item.group;
    if session.starts_with('-') || session.contains([':', '.', '\n', '\r']) {
        return Err("Use a tmux session name as the group".into());
    }
    let status = config_path()?
        .with_file_name("todo-agents")
        .join(format!("{id}.status.json"));
    fs::create_dir_all(status.parent().unwrap()).map_err(|e| e.to_string())?;
    atomic_write(
        &status,
        &serde_json::to_vec(&json!({"state":"started","summary":"Agent starting"}))
            .map_err(|e| e.to_string())?,
    )?;
    let prompt = format!("Work on this task: {}\n\nSource note: {}\nFollow repository AGENTS.md instructions. Keep your status file {} updated as JSON with state (working, blocked, done), summary, and blocker. Report the result when complete. Keep the source checkbox for the controller to verify.", item.text, links.note.display(), status.display());
    let prompt_path = status.with_file_name(format!("{id}.md"));
    atomic_write(&prompt_path, prompt.as_bytes())?;
    let pane = super::service::tmux(&[
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        &format!("={session}"),
        "-n",
        "todo-agent",
        "-c",
        &cwd.to_string_lossy(),
        "codex",
        "-m",
        "gpt-6.1-sol",
        "-c",
        "model_reasoning_effort=\"high\"",
        &prompt,
    ])?;
    let window = super::service::tmux(&["display-message", "-p", "-t", &pane, "#{window_id}"])?;
    let entry = json!({"id":id,"match":item.text,"pane":pane,"window_id":window,"window_name":"todo-agent","session":session,"cwd":cwd,"prompt":prompt_path,"status":status,"state":"started"});
    links.spawned.insert(id.into(), entry.clone());
    save(&links)?;
    if let Some(mapping) = &links.agents {
        register_agent(mapping, &entry).map_err(|error| {
            format!("Agent started; could not update controller mapping: {error}")
        })?;
    }
    snapshot_result()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_identity_survives_checkbox_and_unrelated_line_edits() {
        let before = "---\nid: today\n---\n## gp\n- [ ] First\n  - [ ] Child\n## clawtab\n- [x] Done\n```md\n- [ ] Example\n```\n";
        let tasks = parse(before);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[1].depth, 1);
        assert_eq!(tasks[2].group, "clawtab");
        assert!(tasks[2].checked);
        let after = before
            .replace("## gp", "Some new text\n## gp")
            .replace("[ ] First", "[x] First");
        assert_eq!(tasks[0].id, parse(&after)[0].id);
    }
    #[test]
    fn duplicate_task_lines_have_distinct_ids() {
        let tasks = parse("## work\n- [ ] Same\n- [ ] Same\n");
        assert_ne!(tasks[0].id, tasks[1].id);
    }
    #[test]
    fn checkbox_edit_preserves_frontmatter_nested_tasks_and_crlf() {
        let note = "---\r\nid: today\r\n---\r\n\r\n## gp\r\n- [ ] Parent\r\n  - [ ] Child\r\n\r\n## clawtab\r\n- [x] Reviewed\r\n";
        let id = parse(note)[1].id.clone();
        let updated = checked_note(note, &id, true).unwrap();
        assert_eq!(updated, note.replace("[ ] Child", "[x] Child"));
        assert_eq!(checked_note(&updated, &id, false).unwrap(), note);
        assert!(checked_note(&note.replace("Child", "Renamed"), &id, true).is_err());
    }
    #[test]
    fn adding_is_idempotent_and_stays_in_the_requested_section() {
        let note = "## gp\r\n- [ ] Existing\r\n\r\n## clawtab\r\n- [ ] Release";
        let after = added_note(note, "New task", "gp");
        assert_eq!(added_note(&after, "New task", "gp"), after);
        assert_eq!(
            parse(&after)
                .iter()
                .find(|item| item.text == "New task")
                .unwrap()
                .group,
            "gp"
        );
        assert!(after.ends_with("- [ ] Release"));
        let new_group = added_note(note, "Another", "other");
        assert_eq!(parse(&new_group).last().unwrap().group, "other");
    }
    #[test]
    fn concurrent_source_change_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("today.md");
        let before = "## gp\n- [ ] Task\n";
        let controller = "## gp\n- [x] Task\n- [ ] Added by controller\n";
        fs::write(&path, controller).unwrap();
        assert!(write_note(&path, before, "stale update").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), controller);
        write_note(&path, controller, before).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }
    #[test]
    fn live_source_mapping_and_status_updates_remain_linked() {
        let directory = tempfile::tempdir().unwrap();
        let note = directory.path().join("today.md");
        let mapping = directory.path().join("agents.json");
        let status = directory.path().join("release.status.json");
        fs::write(
            &note,
            "## clawtab\n- [ ] Release\n  - [ ] Posting\n## gp\n- [ ] Research\n",
        )
        .unwrap();
        fs::write(&mapping, json!({"tasks":[{"match":"Release","session":"clawtab","pane":"%42","status":status}],"existing":[{"covers":["Research"],"session":"gp","pane":"%43"}]}).to_string()).unwrap();
        fs::write(&status, r#"{"state":"working","summary":"Testing"}"#).unwrap();
        let links = Links {
            note: note.clone(),
            agents: Some(mapping),
            ..Default::default()
        };
        let before = snapshot_links(&links).unwrap();
        assert_eq!(before["items"].as_array().unwrap().len(), 3);
        assert_eq!(before["items"][1]["agent"]["pane"], "%42");
        assert_eq!(before["items"][2]["agent"]["pane"], "%43");
        let id = before["items"][1]["id"].as_str().unwrap();
        let current = fs::read_to_string(&note).unwrap();
        fs::write(
            &note,
            checked_note(&current, id, true).unwrap() + "- [ ] New task\n",
        )
        .unwrap();
        fs::write(&status, r#"{"state":"done","summary":"Verified"}"#).unwrap();
        let after = snapshot_links(&links).unwrap();
        assert_eq!(after["items"].as_array().unwrap().len(), 4);
        assert_eq!(after["items"][1]["id"], id);
        assert_eq!(after["items"][1]["checked"], true);
        assert_eq!(after["items"][0]["checked"], false);
        assert_eq!(after["items"][1]["agent"]["state"], "done");
    }
    #[test]
    fn new_agent_registration_preserves_controller_metadata_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agents.json");
        fs::write(&path, r#"{"controller_thread":"controller","tasks":[{"id":"existing","pane":"%41","thread":"original"}],"existing":[{"pane":"%40"}]}"#).unwrap();
        let agent = json!({"id":"new","match":"New task","pane":"%42","session":"clawtab","status":"new.status.json"});
        register_agent(&path, &agent).unwrap();
        register_agent(&path, &agent).unwrap();
        let mapping: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(mapping["controller_thread"], "controller");
        assert_eq!(mapping["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(mapping["tasks"][0]["thread"], "original");
        assert_eq!(mapping["existing"][0]["pane"], "%40");
    }
}
