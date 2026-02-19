use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

struct ToolSpec {
    name: &'static str,
    binary: &'static str,
    version_flag: &'static str,
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "tmux",
        binary: "tmux",
        version_flag: "-V",
    },
    ToolSpec {
        name: "claude",
        binary: "claude",
        version_flag: "--version",
    },
    ToolSpec {
        name: "codex",
        binary: "codex",
        version_flag: "--version",
    },
    ToolSpec {
        name: "aerospace",
        binary: "aerospace",
        version_flag: "--version",
    },
    ToolSpec {
        name: "gopass",
        binary: "gopass",
        version_flag: "--version",
    },
    ToolSpec {
        name: "git",
        binary: "git",
        version_flag: "--version",
    },
    ToolSpec {
        name: "node",
        binary: "node",
        version_flag: "--version",
    },
    ToolSpec {
        name: "python3",
        binary: "python3",
        version_flag: "--version",
    },
    ToolSpec {
        name: "docker",
        binary: "docker",
        version_flag: "--version",
    },
    ToolSpec {
        name: "playwright",
        binary: "npx",
        version_flag: "playwright --version",
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

pub fn detect_tools() -> Vec<ToolInfo> {
    TOOLS
        .iter()
        .map(|spec| {
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
            }
        })
        .collect()
}
