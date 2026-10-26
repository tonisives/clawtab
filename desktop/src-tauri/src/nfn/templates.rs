use super::types::NfnAction;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NfnTemplate {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub layout: Vec<Block>,
    #[serde(default)]
    pub actions: Vec<NfnAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub children: Vec<Block>,
}

pub fn directory() -> PathBuf {
    crate::config::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("notification-templates")
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Template IDs use letters, numbers, hyphens, or underscores".into());
    }
    Ok(())
}

pub fn parse(yaml: &str) -> Result<NfnTemplate, String> {
    if yaml.len() > 64 * 1024 {
        return Err("Template exceeds 64 KiB".into());
    }
    let template: NfnTemplate = serde_yml::from_str(yaml).map_err(|e| e.to_string())?;
    validate_id(&template.id)?;
    if template.version != 1 || template.name.trim().is_empty() || template.name.len() > 128 {
        return Err("Templates require version: 1 and a name up to 128 bytes".into());
    }
    fn validate(blocks: &[Block], depth: usize, count: &mut usize) -> Result<(), String> {
        if depth > 8 {
            return Err("Template nesting exceeds eight levels".into());
        }
        for block in blocks {
            *count += 1;
            if *count > 100
                || ![
                    "row", "column", "text", "metadata", "media", "command", "diff", "plan",
                    "choices", "reply", "logs",
                ]
                .contains(&block.kind.as_str())
            {
                return Err("Use at most 100 supported layout primitives".into());
            }
            if block.field.len() > 128 || block.label.len() > 256 {
                return Err("Template field or label is too long".into());
            }
            validate(&block.children, depth + 1, count)?;
        }
        Ok(())
    }
    validate(&template.layout, 0, &mut 0)?;
    let request = super::types::NfnRequest {
        title: template.name.clone(),
        actions: template.actions.clone(),
        ..Default::default()
    };
    request.validate()?;
    Ok(template)
}

pub fn builtins() -> Vec<NfnTemplate> {
    [
        (
            "question",
            "Question",
            "Answer an agent or job",
            vec!["text", "media", "choices", "reply", "logs"],
            vec![("continue", "Continue")],
        ),
        (
            "update",
            "Status update",
            "Progress or results that do not need a decision",
            vec!["text", "details", "media", "logs"],
            vec![("acknowledge", "Got it")],
        ),
        (
            "agent-approval",
            "Agent approval",
            "Inspect an agent's command, changes, or plan",
            vec![
                "text", "command", "diff", "plan", "choices", "reply", "logs",
            ],
            vec![],
        ),
        (
            "social-review",
            "Social review",
            "Review an X post, YouTube video, or Short",
            vec!["text", "media", "choices", "reply", "logs"],
            vec![
                ("approve", "Approve"),
                ("revise", "Request changes"),
                ("reject", "Reject"),
            ],
        ),
        (
            "permission",
            "Permission request",
            "Review background work or a permission request",
            vec!["text", "command", "diff", "choices", "reply", "logs"],
            vec![("approve", "Approve"), ("reject", "Reject")],
        ),
        (
            "yubikey",
            "YubiKey attention",
            "An agent needs attention at a security key",
            vec!["text", "choices", "reply", "logs"],
            vec![("continue", "Continue")],
        ),
        (
            "quick-action",
            "Quick action",
            "Agent model, auto-yes, and installed plugin actions",
            vec!["text", "choices", "reply", "logs"],
            vec![],
        ),
    ]
    .into_iter()
    .map(|(id, name, description, blocks, actions)| NfnTemplate {
        version: 1,
        id: id.into(),
        name: name.into(),
        description: description.into(),
        layout: blocks
            .into_iter()
            .map(|kind| Block {
                kind: if kind == "details" { "text" } else { kind }.into(),
                field: match kind {
                    "text" => "body".into(),
                    "details" => "data.details".into(),
                    "command" | "diff" | "plan" => format!("data.{kind}"),
                    _ => String::new(),
                },
                label: String::new(),
                children: vec![],
            })
            .collect(),
        actions: actions
            .into_iter()
            .map(|(id, label)| NfnAction {
                id: id.into(),
                label: label.into(),
                ..Default::default()
            })
            .collect(),
    })
    .collect()
}

pub fn load_one(id: &str) -> Result<NfnTemplate, String> {
    validate_id(id)?;
    let path = directory().join(format!("{id}.yaml"));
    if path.exists() {
        let template = parse(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)?;
        if template.id != id {
            return Err("Filename must match template ID".into());
        }
        return Ok(template);
    }
    builtins()
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Template not found: {id}"))
}

pub fn list() -> serde_json::Value {
    let mut templates = builtins();
    let mut errors = Vec::new();
    if let Ok(entries) = std::fs::read_dir(directory()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("yaml") {
                continue;
            }
            let result = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|yaml| parse(&yaml))
                .and_then(|t| {
                    if path.file_stem().and_then(|s| s.to_str()) != Some(&t.id) {
                        Err("Filename must match template ID".into())
                    } else {
                        Ok(t)
                    }
                });
            match result {
                Ok(template) => {
                    templates.retain(|t| t.id != template.id);
                    templates.push(template);
                }
                Err(error) => errors.push(serde_json::json!({"path":path,"error":error})),
            }
        }
    }
    let sources: std::collections::HashMap<_, _> = templates
        .iter()
        .filter_map(|t| {
            serde_yml::to_string(t)
                .ok()
                .map(|yaml| (t.id.clone(), yaml))
        })
        .collect();
    serde_json::json!({"sources":sources,"templates":templates,"errors":errors,"directory":directory()})
}

pub fn save(yaml: &str) -> Result<NfnTemplate, String> {
    let template = parse(yaml)?;
    std::fs::create_dir_all(directory()).map_err(|e| e.to_string())?;
    let staged = directory().join(format!(".{}.{}.tmp", template.id, uuid::Uuid::new_v4()));
    std::fs::write(&staged, yaml).map_err(|e| e.to_string())?;
    std::fs::rename(staged, directory().join(format!("{}.yaml", template.id)))
        .map_err(|e| e.to_string())?;
    Ok(template)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn template_paths_and_executable_layouts_are_rejected() {
        assert!(validate_id("../settings").is_err());
        assert!(
            parse("version: 1\nid: custom\nname: Example\nlayout:\n  - type: script\n").is_err()
        );
        let template = parse("version: 1\nid: custom\nname: Example\nlayout:\n  - type: column\n    children:\n      - type: diff\n        field: data.changes\n      - type: reply\n").unwrap();
        assert_eq!(template.layout[0].children.len(), 2);
        for builtin in builtins() {
            assert!(parse(&serde_yml::to_string(&builtin).unwrap()).is_ok());
        }
    }
}
