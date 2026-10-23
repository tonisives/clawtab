//! Hermes v0.22.4 CLI/TUI identity and read-only session metadata.
//! The gateway is shared: its PID, cwd and inherited pane never identify a view.

use super::common::{format_local_timestamp, normalize_optional_str};
use super::{ProcessSnapshot, SessionInfo};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Identity {
    pub home: PathBuf,
    pub session_id: String,
}

pub(crate) fn default_home() -> PathBuf {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".hermes"))
}

pub(crate) fn integration_home() -> PathBuf {
    let root = default_home();
    let mut context = ProcessContext::default();
    if let Ok(home) = std::env::var("HERMES_HOME") {
        context.env.insert("HERMES_HOME".into(), home);
    }
    profile_home(&context, &root).unwrap_or(root)
}

fn basename(value: &str) -> &str {
    value
        .trim_matches(['\'', '"'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
}

#[cfg(test)]
fn is_hermes_command(command: &str) -> bool {
    command_kind(command) == Some(true)
}

pub(crate) fn kind_for_pid(pid: &str, command: &str) -> Option<bool> {
    if let Some(kind) = command_kind(command) {
        return Some(kind);
    }
    let mut words = command.split_whitespace();
    if basename(words.next()?).to_ascii_lowercase().starts_with("python")
        && words.take(5).any(|word| word == "-c")
    {
        return inline_kind(&process_context(pid).args);
    }
    None
}

fn inline_kind(args: &[String]) -> Option<bool> {
    let index = args.iter().take(6).position(|arg| arg == "-c")?;
    let source = args.get(index + 1)?.trim();
    // Published source and bundled launchers execute Python inline. Inspect the
    // real argv boundary so prompt text cannot masquerade as launcher source.
    let entry = (source.starts_with("import os, re, sys")
        || source.starts_with("import os, site, sys;"))
        && source.contains("from hermes_cli.main import main")
        && source.ends_with("sys.exit(main())");
    let runtime = source.starts_with("import os, sys, runpy;")
        && source.contains("import hermes_bootstrap;")
        && ["'", "\""].iter().any(|quote| source.ends_with(&format!(
            "runpy.run_module({quote}hermes_cli.main{quote}, run_name={quote}__main__{quote}, alter_sys=True)"
        )));
    if !entry && !runtime {
        return None;
    }
    let trailing = &args[index + 2..];
    if trailing.first().is_some_and(|arg| arg == "--run-module") {
        return Some(false);
    }
    command_kind(&format!("hermes {}", trailing.join(" ")))
}

pub(crate) fn command_kind(command: &str) -> Option<bool> {
    let args: Vec<&str> = command.split_whitespace().collect();
    let Some(first) = args.first() else {
        return None;
    };
    let program = basename(first).to_ascii_lowercase();
    let start = if matches!(program.as_str(), "hermes" | "hermes.exe") {
        1
    } else if program.starts_with("python") {
        if args.get(1).is_some_and(|arg| basename(arg) == "hermes") {
            2
        } else if args.get(1) == Some(&"-m")
            && args
                .get(2)
                .is_some_and(|arg| matches!(*arg, "hermes_cli" | "hermes_cli.main"))
        {
            3
        } else {
            return None;
        }
    } else if matches!(program.as_str(), "node" | "node.exe" | "bun") {
        return args
            .iter()
            .take(4)
            .any(|arg| {
                arg.ends_with("/hermes_cli/tui_dist/entry.js")
                    || arg.ends_with("/ui-tui/dist/entry.js")
            })
            .then_some(true);
    } else {
        return None;
    };
    // Inspect the command position, never model names or the user's prompt.
    let mut index = start;
    while let Some(arg) = args.get(index) {
        match *arg {
            "--help" | "-h" | "--version" => return Some(false),
            "--profile" | "-p" | "--model" | "-m" | "--provider" | "--reasoning" | "--in"
            | "--resume" | "-r" | "--toolsets" | "-t" | "--skills" | "-s" | "--base-url"
            | "--api-key" => index += 2,
            "chat" | "-z" | "--oneshot" | "-c" | "--continue" | "--query" | "-q"
            | "--query-file" => return Some(true),
            value if value.starts_with('-') => index += 1,
            _ => return Some(false),
        }
    }
    Some(true)
}

#[derive(Default)]
struct ProcessContext {
    args: Vec<String>,
    env: HashMap<String, String>,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
const ENV_KEYS: &[&str] = &[
    "HERMES_HOME",
    "HERMES_TUI_ACTIVE_SESSION_FILE",
    "TMUX_PANE",
    "CLAWTAB_SESSION_ID",
];

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn selected_environment<'a>(entries: impl Iterator<Item = &'a [u8]>) -> HashMap<String, String> {
    entries
        .filter_map(|bytes| {
            let value = std::str::from_utf8(bytes).ok()?;
            let (key, value) = value.split_once('=')?;
            ENV_KEYS
                .contains(&key)
                .then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn process_context(pid: &str) -> ProcessContext {
    let Ok(pid) = pid.parse::<i32>() else {
        return ProcessContext::default();
    };
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = 0;
    // KERN_PROCARGS2 returns argc, executable path, argv and the initial env.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || !(4..=4 * 1024 * 1024).contains(&size)
    {
        return ProcessContext::default();
    }
    let mut bytes = vec![0_u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return ProcessContext::default();
    }
    bytes.truncate(size);
    parse_procargs(&bytes)
}

#[cfg(any(target_os = "macos", test))]
fn parse_procargs(bytes: &[u8]) -> ProcessContext {
    let Some(count) = bytes
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .map(i32::from_ne_bytes)
    else {
        return ProcessContext::default();
    };
    if !(0..=65536).contains(&count) {
        return ProcessContext::default();
    }
    let Some(end) = bytes[4..].iter().position(|byte| *byte == 0) else {
        return ProcessContext::default();
    };
    let start = 4 + end;
    let Some(offset) = bytes[start..].iter().position(|byte| *byte != 0) else {
        return ProcessContext::default();
    };
    let mut entries = bytes[start + offset..].split(|byte| *byte == 0);
    let args = entries
        .by_ref()
        .take(count as usize)
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .collect();
    ProcessContext {
        args,
        env: selected_environment(entries),
    }
}

#[cfg(target_os = "linux")]
fn process_context(pid: &str) -> ProcessContext {
    if pid.parse::<u32>().is_err() {
        return ProcessContext::default();
    }
    let args = std::fs::read(format!("/proc/{pid}/cmdline"))
        .unwrap_or_default()
        .split(|byte| *byte == 0)
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .collect();
    let bytes = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
    ProcessContext {
        args,
        env: selected_environment(bytes.split(|byte| *byte == 0)),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_context(_pid: &str) -> ProcessContext {
    ProcessContext::default()
}

fn argument<'a>(args: &'a [String], names: &[&str]) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(index, arg)| {
        if names.contains(&arg.as_str()) {
            return args.get(index + 1).map(String::as_str);
        }
        arg.split_once('=')
            .filter(|(key, _)| names.contains(key))
            .map(|(_, value)| value)
    })
}

fn profile_home(context: &ProcessContext, root: &Path) -> Option<PathBuf> {
    let explicit = context
        .env
        .get("HERMES_HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    let root = explicit.as_deref().unwrap_or(root);
    let root = if root
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "profiles")
    {
        root.parent()?.parent()?
    } else {
        root
    };
    if let Some(profile) = argument(&context.args, &["--profile", "-p"]) {
        if profile == "default" {
            return Some(root.to_path_buf());
        }
        if profile.is_empty()
            || profile == "."
            || profile == ".."
            || !profile
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"_-".contains(&ch))
        {
            return None;
        }
        return Some(root.join("profiles").join(profile.to_ascii_lowercase()));
    }
    if explicit.as_ref().is_some_and(|home| {
        home.parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "profiles")
    }) {
        return explicit;
    }
    let active = std::fs::read_to_string(root.join("active_profile")).unwrap_or_default();
    let active = active.trim();
    if !active.is_empty() && active != "default" {
        let mut context = ProcessContext::default();
        context.args = vec!["--profile".into(), active.into()];
        return profile_home(&context, root);
    }
    Some(root.to_path_buf())
}

fn home_candidates(context: &ProcessContext, root: &Path) -> Vec<PathBuf> {
    let Some(selected) = profile_home(context, root) else {
        return Vec::new();
    };
    let mut homes = vec![selected];
    let pinned = argument(&context.args, &["--profile", "-p"]).is_some()
        || context.env.get("HERMES_HOME").is_some_and(|home| {
            Path::new(home)
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "profiles")
        });
    if !pinned {
        // The sticky default can change after launch. macOS exposes the initial
        // environment, so check fresh terminal breadcrumbs in sibling profiles
        // as well. A matching cwd or newest database row is never enough.
        let root = context
            .env
            .get("HERMES_HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.into());
        if !homes.contains(&root) {
            homes.push(root.clone());
        }
        if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
            for entry in entries.flatten().take(128) {
                if entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && !homes.contains(&entry.path())
                {
                    homes.push(entry.path());
                }
            }
        }
    }
    homes
}

#[derive(Deserialize)]
struct Breadcrumb {
    session_id: String,
    ts: Option<f64>,
}

fn read_identity_file(
    path: &Path,
    start_epoch: Option<i64>,
    require_timestamp: bool,
) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > 16 * 1024 {
        return None;
    }
    let crumb: Breadcrumb = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if crumb.session_id.trim().is_empty() || crumb.session_id.len() > 256 {
        return None;
    }
    if require_timestamp
        && !crumb.ts.is_some_and(|ts| {
            ts.is_finite() && start_epoch.is_some_and(|start| ts >= (start - 2) as f64)
        })
    {
        return None;
    }
    Some(crumb.session_id)
}

fn tty_breadcrumb(pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", pid, "-o", "tty="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let tty = String::from_utf8(output.stdout).ok()?;
    let tty = tty.trim();
    if tty.is_empty() || tty == "??" || tty == "?" {
        return None;
    }
    let path = if tty.starts_with('/') {
        tty.to_string()
    } else {
        format!("/dev/{tty}")
    };
    Some(format!("tty-{}", sanitize_terminal_id(&path)))
}

fn sanitize_terminal_id(value: &str) -> String {
    value
        .trim()
        .trim_matches('/')
        .chars()
        .take(120)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

pub(crate) fn identity_for_pane(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<Identity> {
    let owned;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned = ProcessSnapshot::capture();
            &owned
        }
    };
    let mut pids: Vec<_> = snapshot
        .process_tree_pids(pane_pid)
        .into_iter()
        .filter(|pid| {
            snapshot
                .command_for_pid(pid)
                .is_some_and(|command| kind_for_pid(pid, command) == Some(true))
        })
        .collect();
    // The node view exposes its current session file; prefer it over its launcher.
    pids.sort_by_key(|pid| {
        !snapshot
            .command_for_pid(pid)
            .is_some_and(|cmd| cmd.contains("/entry.js"))
    });
    for pid in pids {
        let context = process_context(&pid);
        let homes = home_candidates(&context, &default_home());
        if let Some(path) = context.env.get("HERMES_TUI_ACTIVE_SESSION_FILE") {
            // A TUI switch updates this exact per-process file. Do not fall back
            // to a launch argument or an old terminal breadcrumb when it is empty.
            let home = homes
                .first()?
                .canonicalize()
                .unwrap_or_else(|_| homes[0].clone());
            return read_identity_file(Path::new(path), None, false)
                .map(|session_id| Identity { home, session_id });
        }
        let terminal = tty_breadcrumb(&pid).or_else(|| {
            context
                .env
                .get("TMUX_PANE")
                .map(|pane| format!("tmux_pane-{}", sanitize_terminal_id(pane)))
        });
        if let Some(terminal) = terminal {
            for home in homes {
                if let Some(session_id) = read_identity_file(
                    &home.join("terminal-sessions").join(&terminal),
                    snapshot.start_epoch_for_pid(&pid),
                    true,
                ) {
                    let home = home.canonicalize().unwrap_or(home);
                    return Some(Identity { home, session_id });
                }
            }
        }
    }
    None
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    identity_for_pane(pane_pid, snapshot)
        .map(|identity| read_session(&identity))
        .unwrap_or_default()
}

fn read_session(identity: &Identity) -> SessionInfo {
    let mut info = SessionInfo::default();
    // Hermes creates the durable row lazily on the first turn. The view's
    // explicit identity is already authoritative after /new and before that.
    info.session_id = Some(identity.session_id.clone());
    let profile = if identity
        .home
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "profiles")
    {
        ""
    } else {
        " --profile default"
    };
    info.restore_command = Some(format!(
        "HERMES_HOME={} hermes{profile} chat --resume {}",
        super::shell_quote(&identity.home.to_string_lossy()),
        super::shell_quote(&identity.session_id)
    ));
    let Ok(conn) = Connection::open_with_flags(
        identity.home.join("state.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return info;
    };
    let _ = conn.busy_timeout(Duration::from_millis(100));
    let row = conn.query_row(
        "SELECT title, model, started_at, coalesce(input_tokens, 0) + coalesce(output_tokens, 0) FROM sessions WHERE id = ?1",
        [&identity.session_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, f64>(2)?, row.get::<_, i64>(3)?)),
    );
    let Ok((title, model, started, tokens)) = row else {
        return info;
    };
    info.session_id = Some(identity.session_id.clone());
    info.title = title.and_then(|text| normalize_optional_str(&text));
    info.model_id = model.and_then(|text| normalize_optional_str(&text));
    if started.is_finite() && started >= 0.0 {
        info.started_epoch = Some(started as u64);
        info.session_started_at = format_local_timestamp(started as i64);
    }
    info.token_count = u64::try_from(tokens).ok();
    // Active human rows exclude old compaction generations and observed inputs.
    let filter = "session_id = ?1 AND role = 'user' AND active = 1 AND coalesce(observed, 0) = 0 AND coalesce(_compressed_summary, 0) = 0";
    for (order, first) in [("ASC", true), ("DESC", false)] {
        let query = format!("SELECT content, timestamp FROM messages WHERE {filter} ORDER BY timestamp {order}, id {order} LIMIT 1");
        if let Ok((content, timestamp)) = conn.query_row(&query, [&identity.session_id], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, f64>(1)?))
        }) {
            let content = content.and_then(|text| message_text(&text));
            if first {
                info.first_query = content
            } else {
                info.last_query = content;
                if timestamp.is_finite() && timestamp >= 0.0 {
                    info.last_user_message_at = Some((timestamp * 1000.0) as i64)
                }
            }
        }
    }
    info
}

fn message_text(content: &str) -> Option<String> {
    if let Ok(serde_json::Value::Array(parts)) = serde_json::from_str(content) {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        normalize_optional_str(&text)
    } else {
        normalize_optional_str(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cli_and_tui_without_matching_prompt_text_or_gateway() {
        for command in [
            "hermes",
            "/opt/venv/bin/python /opt/venv/bin/hermes chat --model claude-sonnet --query codex",
            "python3 -m hermes_cli.main --profile coder chat",
            "hermes --model claude-opus chat --cli",
            "node --expose-gc /opt/hermes-agent/ui-tui/dist/entry.js",
            "node /opt/hermes_cli/tui_dist/entry.js",
            "hermes --resume abc",
            "hermes --query explain this codex project",
            "hermes --base-url http://localhost:1234 --query-file /tmp/prompt with spaces",
        ] {
            assert!(is_hermes_command(command), "{command}");
        }
        for command in [
            "echo hermes",
            "codex implement hermes support",
            "python /work/hermes_report.py",
            "hermes gateway run",
            "hermes --profile coder sessions list",
            "hermes setup",
            "node /work/other/entry.js",
            "hermes-mcp",
            "python -m hermes_gateway",
            "hermes --version",
        ] {
            assert!(!is_hermes_command(command), "{command}");
        }
        assert_eq!(
            super::super::provider_for_command(Some("hermes gateway --model codex")),
            None
        );
    }

    #[test]
    fn inline_launchers_use_actual_source_and_trailing_arguments() {
        for source in [
            "import os, re, sys\nfrom hermes_cli.main import main\nsys.exit(main())",
            "import os, site, sys; sys.argv[0]='hermes'; site.addsitedir(os.environ['HERMES_SITE']); from hermes_cli.main import main; sys.exit(main())",
            "import os, sys, runpy; import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)",
        ] {
            let mut args = vec!["python3".into(), "-I".into(), "-c".into(), source.into(), "chat".into()];
            assert_eq!(inline_kind(&args), Some(true));
            args[4] = "gateway".into();
            assert_eq!(inline_kind(&args), Some(false));
            args[4] = "--run-module".into();
            assert_eq!(inline_kind(&args), Some(false));
            args[3] = format!("print({source:?})");
            assert_eq!(inline_kind(&args), None);
        }
    }

    #[test]
    fn procargs_keep_arguments_and_only_identity_environment() {
        let mut bytes = 3_i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/bin/python\0\0python\0/venv/bin/hermes\0chat\0HERMES_HOME=/tmp/profile with spaces\0UNRELATED_TOKEN=not-retained\0TMUX_PANE=%2\0");
        let context = parse_procargs(&bytes);
        assert_eq!(context.args, ["python", "/venv/bin/hermes", "chat"]);
        assert_eq!(context.env.len(), 2);
        assert_eq!(context.env["HERMES_HOME"], "/tmp/profile with spaces");
        assert!(parse_procargs(b"bad").args.is_empty());
    }

    #[test]
    fn profile_selection_respects_custom_roots_and_named_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let mut context = ProcessContext::default();
        fs_write_active(dir.path(), "coder");
        assert_eq!(
            profile_home(&context, dir.path()),
            Some(dir.path().join("profiles/coder"))
        );
        context.env.insert(
            "HERMES_HOME".into(),
            dir.path().to_string_lossy().into_owned(),
        );
        assert_eq!(
            profile_home(&context, Path::new("/ignored")),
            Some(dir.path().join("profiles/coder"))
        );
        context
            .env
            .insert("HERMES_HOME".into(), "/custom/profiles/other".into());
        assert_eq!(
            profile_home(&context, dir.path()),
            Some(PathBuf::from("/custom/profiles/other"))
        );
        context.args = vec!["hermes".into(), "--profile=coder".into(), "chat".into()];
        assert_eq!(
            profile_home(&context, dir.path()),
            Some(PathBuf::from("/custom/profiles/coder"))
        );
        context.args[1] = "--profile=../other".into();
        assert!(profile_home(&context, dir.path()).is_none());
    }

    #[test]
    fn a_changed_sticky_profile_keeps_the_original_home_as_a_candidate() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("profiles/old")).unwrap();
        std::fs::create_dir_all(dir.path().join("profiles/new")).unwrap();
        fs_write_active(dir.path(), "new");
        let context = ProcessContext::default();
        let homes = home_candidates(&context, dir.path());
        assert!(homes.contains(&dir.path().join("profiles/old")));
        assert!(homes.contains(&dir.path().to_path_buf()));
        let mut context = context;
        context.args = vec!["--profile".into(), "new".into()];
        assert_eq!(
            home_candidates(&context, dir.path()),
            vec![dir.path().join("profiles/new")]
        );
    }

    fn fs_write_active(root: &Path, name: &str) {
        std::fs::write(root.join("active_profile"), name).unwrap();
    }

    #[test]
    fn stale_and_malformed_breadcrumbs_cannot_attach_previous_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tty-dev-ttys123");
        std::fs::write(&file, r#"{"session_id":"old","ts":10}"#).unwrap();
        assert_eq!(read_identity_file(&file, Some(50), true), None);
        assert_eq!(read_identity_file(&file, None, true), None);
        std::fs::write(&file, r#"{"session_id":"current","ts":50}"#).unwrap();
        assert_eq!(
            read_identity_file(&file, Some(50), true).as_deref(),
            Some("current")
        );
        std::fs::write(&file, r#"{"session_id":"switched"}"#).unwrap();
        assert_eq!(
            read_identity_file(&file, None, false).as_deref(),
            Some("switched")
        );
        std::fs::write(&file, "{").unwrap();
        assert_eq!(read_identity_file(&file, None, false), None);
        assert_eq!(sanitize_terminal_id("/dev/pts/12"), "dev-pts-12");
        assert_eq!(sanitize_terminal_id("%12"), "-12");
    }

    fn database(home: &Path, title: &str) {
        let conn = Connection::open(home.join("state.db")).unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, model TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER, observed INTEGER, _compressed_summary INTEGER);").unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES ('same', ?1, 'provider/model', 100.25, 120, 30)",
            [title],
        )
        .unwrap();
        for (id, role, content, active, observed, summary) in [
            (1, "user", "first question", 1, 0, 0),
            (2, "assistant", "answer", 1, 0, 0),
            (3, "user", "old generation", 0, 0, 0),
            (
                4,
                "user",
                r#"[{"type":"text","text":"latest question"},{"type":"image_url","image_url":{"url":"ignored"}}]"#,
                1,
                0,
                0,
            ),
            (5, "user", "observation", 1, 1, 0),
            (6, "user", "compaction summary", 1, 0, 1),
        ] {
            conn.execute(
                "INSERT INTO messages VALUES (?1, 'same', ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    id,
                    role,
                    content,
                    100.0 + f64::from(id),
                    active,
                    observed,
                    summary
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn reads_only_the_bound_profile_and_active_human_messages() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        database(first.path(), "First profile");
        database(second.path(), "Second profile");
        for (dir, title) in [(&first, "First profile"), (&second, "Second profile")] {
            let info = read_session(&Identity {
                home: dir.path().into(),
                session_id: "same".into(),
            });
            assert_eq!(info.title.as_deref(), Some(title));
            assert_eq!(info.model_id.as_deref(), Some("provider/model"));
            assert_eq!(info.first_query.as_deref(), Some("first question"));
            assert_eq!(info.last_query.as_deref(), Some("latest question"));
            assert_eq!(info.last_user_message_at, Some(104000));
            assert_eq!(info.token_count, Some(150));
            assert!(info
                .restore_command
                .unwrap()
                .contains(&dir.path().to_string_lossy().to_string()));
        }
    }

    #[test]
    fn missing_or_incompatible_store_does_not_create_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let identity = Identity {
            home: dir.path().into(),
            session_id: "same".into(),
        };
        assert_eq!(read_session(&identity).session_id.as_deref(), Some("same"));
        assert!(read_session(&identity).first_query.is_none());
        assert!(!dir.path().join("state.db").exists());
        std::fs::write(dir.path().join("state.db"), b"not sqlite").unwrap();
        assert!(read_session(&identity).first_query.is_none());
    }
}
