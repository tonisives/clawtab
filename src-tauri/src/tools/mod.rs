use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub category: String,
    pub required: bool,
    pub group: Option<String>,
    pub brew_formula: Option<String>,
}

struct ToolSpec {
    name: &'static str,
    binary: &'static str,
    version_flag: &'static str,
    category: &'static str,
    required: bool,
    group: Option<&'static str>,
    brew_formula: Option<&'static str>,
}

const TOOLS: &[ToolSpec] = &[
    // AI Agent
    ToolSpec {
        name: "claude",
        binary: "claude",
        version_flag: "--version",
        category: "AI Agent",
        required: true,
        group: Some("ai_agent"),
        brew_formula: None,
    },
    ToolSpec {
        name: "codex",
        binary: "codex",
        version_flag: "--version",
        category: "AI Agent",
        required: true,
        group: Some("ai_agent"),
        brew_formula: None,
    },
    // Terminal
    ToolSpec {
        name: "ghostty",
        binary: "ghostty",
        version_flag: "--version",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: Some("--cask ghostty"),
    },
    ToolSpec {
        name: "alacritty",
        binary: "alacritty",
        version_flag: "--version",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: Some("--cask alacritty"),
    },
    ToolSpec {
        name: "kitty",
        binary: "kitty",
        version_flag: "--version",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: Some("--cask kitty"),
    },
    ToolSpec {
        name: "wezterm",
        binary: "wezterm",
        version_flag: "--version",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: Some("--cask wezterm"),
    },
    ToolSpec {
        name: "iTerm2",
        binary: "iTerm2",
        version_flag: "--version",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: Some("--cask iterm2"),
    },
    ToolSpec {
        name: "Terminal.app",
        binary: "Terminal.app",
        version_flag: "",
        category: "Terminal",
        required: true,
        group: Some("terminal"),
        brew_formula: None,
    },
    // Editor
    ToolSpec {
        name: "nvim",
        binary: "nvim",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("neovim"),
    },
    ToolSpec {
        name: "vim",
        binary: "vim",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("vim"),
    },
    ToolSpec {
        name: "code",
        binary: "code",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("--cask visual-studio-code"),
    },
    ToolSpec {
        name: "codium",
        binary: "codium",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("--cask vscodium"),
    },
    ToolSpec {
        name: "zed",
        binary: "zed",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("--cask zed"),
    },
    ToolSpec {
        name: "hx",
        binary: "hx",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("helix"),
    },
    ToolSpec {
        name: "subl",
        binary: "subl",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("--cask sublime-text"),
    },
    ToolSpec {
        name: "emacs",
        binary: "emacs",
        version_flag: "--version",
        category: "Editor",
        required: true,
        group: Some("editor"),
        brew_formula: Some("emacs"),
    },
    // Optional
    ToolSpec {
        name: "tmux",
        binary: "tmux",
        version_flag: "-V",
        category: "Required",
        required: true,
        group: None,
        brew_formula: Some("tmux"),
    },
    ToolSpec {
        name: "git",
        binary: "git",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("git"),
    },
    ToolSpec {
        name: "aerospace",
        binary: "aerospace",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("nikitabobko/tap/aerospace"),
    },
    ToolSpec {
        name: "gopass",
        binary: "gopass",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("gopass"),
    },
    ToolSpec {
        name: "node",
        binary: "node",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("node"),
    },
    ToolSpec {
        name: "python3",
        binary: "python3",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("python3"),
    },
    ToolSpec {
        name: "docker",
        binary: "docker",
        version_flag: "--version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: Some("--cask docker"),
    },
    ToolSpec {
        name: "playwright",
        binary: "npx",
        version_flag: "playwright --version",
        category: "Optional",
        required: false,
        group: None,
        brew_formula: None,
    },
    // Messaging
    ToolSpec {
        name: "Telegram",
        binary: "Telegram",
        version_flag: "",
        category: "Required",
        required: true,
        group: None,
        brew_formula: Some("--cask telegram"),
    },
];

fn which(binary: &str) -> Option<String> {
    let output = Command::new("which").arg(binary).output().ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    } else {
        None
    }
}

/// Check if a binary exists next to the current executable (bundled sibling)
fn sibling_binary(binary: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(binary);
    if candidate.exists() {
        Some(candidate.display().to_string())
    } else {
        None
    }
}

/// Resolve the binary path: custom path > sibling > which
fn resolve_binary(spec: &ToolSpec, custom_paths: &HashMap<String, String>) -> Option<String> {
    // 1. User-specified custom path
    if let Some(custom) = custom_paths.get(spec.name) {
        if !custom.is_empty() && std::path::Path::new(custom).exists() {
            return Some(custom.clone());
        }
    }
    // 2. Bundled sibling binary
    if let Some(path) = sibling_binary(spec.binary) {
        return Some(path);
    }
    // 3. Standard PATH lookup
    which(spec.binary)
}

fn get_version_from(binary_path: &str, spec: &ToolSpec) -> Option<String> {
    let output = if spec.name == "playwright" {
        Command::new(binary_path)
            .args(spec.version_flag.split_whitespace())
            .output()
            .ok()?
    } else {
        Command::new(binary_path)
            .arg(spec.version_flag)
            .output()
            .ok()?
    };

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.is_empty() {
                None
            } else {
                Some(extract_version_string(&stderr))
            }
        } else {
            Some(extract_version_string(&text))
        }
    } else {
        None
    }
}

fn extract_version_string(raw: &str) -> String {
    raw.lines().next().unwrap_or(raw).to_string()
}

/// Check if a terminal app is running via process list
fn is_terminal_running(name: &str) -> bool {
    let output = Command::new("ps").args(["-eo", "comm"]).output().ok();
    let procs = output
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let needle = match name {
        "iTerm2" => "iTerm",
        other => other,
    };
    procs.lines().any(|line| line.contains(needle))
}

/// Detect a single tool's availability
fn detect_tool(spec: &ToolSpec, custom_paths: &HashMap<String, String>) -> ToolInfo {
    // Telegram is a macOS .app bundle, not a PATH binary
    if spec.name == "Telegram" {
        let app_path = "/Applications/Telegram.app";
        let available = std::path::Path::new(app_path).exists();
        return ToolInfo {
            name: spec.name.to_string(),
            available,
            version: if available {
                Some("installed".to_string())
            } else {
                None
            },
            path: if available {
                Some(app_path.to_string())
            } else {
                None
            },
            category: spec.category.to_string(),
            required: spec.required,
            group: spec.group.map(|s| s.to_string()),
            brew_formula: spec.brew_formula.map(|s| s.to_string()),
        };
    }

    // Terminal.app is always available on macOS
    if spec.name == "Terminal.app" {
        return ToolInfo {
            name: spec.name.to_string(),
            available: true,
            version: Some("built-in".to_string()),
            path: Some("/System/Applications/Utilities/Terminal.app".to_string()),
            category: spec.category.to_string(),
            required: spec.required,
            group: spec.group.map(|s| s.to_string()),
            brew_formula: spec.brew_formula.map(|s| s.to_string()),
        };
    }

    // For terminal apps, check both binary resolution and running process
    if spec.category == "Terminal" {
        let path = resolve_binary(spec, custom_paths);
        let running = is_terminal_running(spec.name);
        let available = path.is_some() || running;
        let version = path.as_ref().and_then(|p| get_version_from(p, spec));
        return ToolInfo {
            name: spec.name.to_string(),
            available,
            version,
            path,
            category: spec.category.to_string(),
            required: spec.required,
            group: spec.group.map(|s| s.to_string()),
            brew_formula: spec.brew_formula.map(|s| s.to_string()),
        };
    }

    // Standard detection: custom path > sibling > which
    let path = resolve_binary(spec, custom_paths);
    let available = path.is_some();
    let version = if available {
        path.as_ref().and_then(|p| get_version_from(p, spec))
    } else {
        None
    };
    ToolInfo {
        name: spec.name.to_string(),
        available,
        version,
        path,
        category: spec.category.to_string(),
        required: spec.required,
        group: spec.group.map(|s| s.to_string()),
        brew_formula: spec.brew_formula.map(|s| s.to_string()),
    }
}

pub fn detect_tools(custom_paths: &HashMap<String, String>) -> Vec<ToolInfo> {
    TOOLS.iter().map(|s| detect_tool(s, custom_paths)).collect()
}
