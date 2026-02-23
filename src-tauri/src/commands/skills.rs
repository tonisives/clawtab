use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub content: String,
}

fn skills_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("skills")
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillEntry>, String> {
    let dir = skills_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Failed to read skills dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content = std::fs::read_to_string(&skill_md)
            .map_err(|e| format!("Failed to read {}: {}", skill_md.display(), e))?;
        skills.push(SkillEntry { name, content });
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
pub fn read_skill(name: String) -> Result<String, String> {
    let skill_md = skills_dir().join(&name).join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!("Skill '{}' not found", name));
    }
    std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("Failed to read {}: {}", skill_md.display(), e))
}

#[tauri::command]
pub fn write_skill(name: String, content: String) -> Result<(), String> {
    let skill_dir = skills_dir().join(&name);
    let skill_md = skill_dir.join("SKILL.md");
    if let Some(parent) = skill_md.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create skill dir: {}", e))?;
    }
    std::fs::write(&skill_md, content)
        .map_err(|e| format!("Failed to write {}: {}", skill_md.display(), e))
}

#[tauri::command]
pub fn delete_skill(name: String) -> Result<(), String> {
    let skill_dir = skills_dir().join(&name);
    if !skill_dir.exists() {
        return Err(format!("Skill '{}' not found", name));
    }
    std::fs::remove_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to delete skill '{}': {}", name, e))
}

#[tauri::command]
pub fn open_skill_in_editor(state: State<AppState>, name: String) -> Result<(), String> {
    let skill_md = skills_dir().join(&name).join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!("Skill '{}' not found", name));
    }

    let preferred_editor = {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    };

    let file_path_str = skill_md.display().to_string();

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        editor => {
            let cmd = format!("{} {}", editor, file_path_str);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}
