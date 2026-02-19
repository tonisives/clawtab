use serde::Serialize;
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
    ToolSpec {
        name: "cwdt-browse",
        binary: "cwdt-browse",
        version_flag: "--help",
        category: "Browser",
        required: false,
        group: None,
        brew_formula: None,
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

fn get_version(spec: &ToolSpec) -> Option<String> {
    let output = if spec.name == "playwright" {
        Command::new(spec.binary)
            .args(spec.version_flag.split_whitespace())
            .output()
            .ok()?
    } else {
        Command::new(spec.binary)
            .arg(spec.version_flag)
            .output()
            .ok()?
    };

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            // Some tools write version to stderr
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
    // Take just the first line
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
fn detect_tool(spec: &ToolSpec) -> ToolInfo {
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

    // For terminal apps, check both binary in PATH and running process
    if spec.category == "Terminal" {
        let path = which(spec.binary);
        let running = is_terminal_running(spec.name);
        let available = path.is_some() || running;
        let version = if path.is_some() {
            get_version(spec)
        } else {
            None
        };
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

    // Standard detection via which + version
    let path = which(spec.binary);
    let available = path.is_some();
    let version = if available {
        get_version(spec)
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

pub fn detect_tools() -> Vec<ToolInfo> {
    TOOLS.iter().map(detect_tool).collect()
}
