use std::collections::{HashMap, HashSet};

use crate::agent_session::{detect_process_provider, ProcessProvider, ProcessSnapshot};

const SEPARATOR: &str = "|CT|";
pub(super) const MANUAL_RENAME_HOOK: &str = "if-shell -F '#{==:#{@clawtab-title-renaming},1}' 'set-option -wqu @clawtab-title-renaming' 'set-option -wq @clawtab-manual-window-name 1'";

struct TitlePane<'a> {
    pane_id: &'a str,
    window_id: &'a str,
    window_name: &'a str,
    automatic_rename: bool,
    last_window_title: &'a str,
    manual_window_name: bool,
    cached_title: &'a str,
    border_cache_command: &'a str,
    title: Option<String>,
    is_agent: bool,
}

/// Refresh generated labels separately from OSC pane titles, which Codex uses
/// to identify daemon-backed sessions. Run even when no UI client is connected.
pub fn sync_agent_titles(snapshot: &ProcessSnapshot) -> Result<(), String> {
    let output = super::run(
        &["list-panes", "-a", "-F", "#{pane_id}|CT|#{pane_pid}|CT|#{pane_current_path}|CT|#{window_id}|CT|#{window_name}|CT|#{automatic-rename}|CT|#{@clawtab-auto-window-name}|CT|#{@clawtab-manual-window-name}|CT|#{@clawtab-agent-title}|CT|#{@clawtab-display-name}|CT|#{session_name}|CT|#{@clawtab-pane-border-cache-command}"],
        "tmux::sync_agent_titles::list_panes",
    ).map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let panes: Vec<_> = stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.splitn(12, SEPARATOR).collect();
            if fields.len() != 12
                || (fields[10].starts_with("clawtab-") && fields[10].contains("-view-"))
            {
                return None;
            }
            let provider = detect_process_provider(fields[1], Some(snapshot));
            let is_agent = provider.is_some_and(|provider| provider != ProcessProvider::Shell);
            let title = if is_agent {
                let info = crate::agent_session::resolve_session_info_for_provider_with_cwd_fast(
                    fields[1],
                    provider,
                    Some(snapshot),
                    Some(fields[2]),
                );
                // Explicit pane names take priority over provider-generated names.
                let name = if fields[9].is_empty() {
                    info.title
                } else {
                    Some(fields[9].to_string())
                };
                name.and_then(|name| clean_title(&name))
            } else {
                None
            };
            Some(TitlePane {
                pane_id: fields[0],
                window_id: fields[3],
                window_name: fields[4],
                automatic_rename: fields[5] == "1",
                last_window_title: fields[6],
                manual_window_name: fields[7] == "1",
                cached_title: fields[8],
                title,
                is_agent,
                border_cache_command: fields[11],
            })
        })
        .collect();
    let commands = title_commands(&panes);
    if commands.is_empty() {
        return Ok(());
    }
    // The hook distinguishes our own rename from an explicit user rename,
    // including one that happens to choose the current generated name.
    let mut args = vec![
        "set-hook".to_string(),
        "-g".to_string(),
        "after-rename-window[111]".to_string(),
        MANUAL_RENAME_HOOK.to_string(),
    ];
    for command in commands {
        args.push(";".to_string());
        args.extend(command);
    }
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    let output =
        super::run(&args, "tmux::sync_agent_titles::apply").map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn clean_title(title: &str) -> Option<String> {
    let title: String = title.chars().filter(|ch| !ch.is_control()).collect();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn title_commands(panes: &[TitlePane<'_>]) -> Vec<Vec<String>> {
    let mut counts = HashMap::<&str, usize>::new();
    let mut seen = HashSet::new();
    for pane in panes {
        // Linked windows appear once per session in `list-panes -a`.
        if pane.is_agent && seen.insert(pane.pane_id) {
            *counts.entry(pane.window_id).or_default() += 1;
        }
    }
    let mut commands = Vec::new();
    seen.clear();
    for pane in panes {
        if !seen.insert(pane.pane_id) {
            continue;
        }
        let title = pane.title.as_deref().unwrap_or("");
        // Pane options are rendered as tmux formats: hashes must stay literal.
        let escaped_title = title.replace('#', "##");
        if pane.cached_title != escaped_title {
            commands.push(command(&[
                "set-option",
                "-pq",
                "-t",
                pane.pane_id,
                "@clawtab-agent-title",
                &escaped_title,
            ]));
            if !pane.border_cache_command.is_empty() {
                commands.push(command(&[
                    "run-shell",
                    "-b",
                    "-t",
                    pane.pane_id,
                    "#{@clawtab-pane-border-cache-command} '#{pane_id}'",
                ]));
            }
        }
        if title.is_empty() || counts.get(pane.window_id) != Some(&1) || pane.manual_window_name {
            continue;
        }
        let owns_window_name =
            !pane.last_window_title.is_empty() && pane.last_window_title == pane.window_name;
        if !pane.automatic_rename && !owns_window_name {
            continue;
        }
        // A manually renamed window must stay protected even if the user
        // re-enables tmux's automatic-rename option afterwards.
        if !pane.last_window_title.is_empty() && !owns_window_name {
            commands.push(command(&[
                "set-option",
                "-wq",
                "-t",
                pane.window_id,
                "@clawtab-manual-window-name",
                "1",
            ]));
            continue;
        }
        if pane.window_name != title {
            commands.push(command(&[
                "set-option",
                "-wq",
                "-t",
                pane.window_id,
                "@clawtab-title-renaming",
                "1",
            ]));
            // rename-window expands formats even without a -F flag.
            commands.push(command(&[
                "rename-window",
                "-t",
                pane.window_id,
                "--",
                &escaped_title,
            ]));
            commands.push(command(&[
                "set-option",
                "-wq",
                "-t",
                pane.window_id,
                "@clawtab-auto-window-name",
                title,
            ]));
        }
    }
    commands
}

fn command(args: &[&str]) -> Vec<String> {
    // tmux's argv parser treats a trailing semicolon as a command separator,
    // even inside a single argument. Escape only that final character.
    args.iter()
        .map(|arg| match arg.strip_suffix(';') {
            Some(prefix) => format!("{prefix}\\;"),
            None => arg.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(pane_id: &str) -> TitlePane<'_> {
        TitlePane {
            pane_id,
            window_id: "@1",
            window_name: "zsh",
            automatic_rename: true,
            last_window_title: "",
            manual_window_name: false,
            cached_title: "",
            border_cache_command: "",
            title: Some("Repair state".to_string()),
            is_agent: true,
        }
    }

    fn renames(panes: &[TitlePane<'_>]) -> usize {
        title_commands(panes)
            .iter()
            .filter(|args| args[0] == "rename-window")
            .count()
    }

    #[test]
    fn one_agent_with_shell_panes_renames_but_two_agents_do_not() {
        let mut shell = pane("%2");
        shell.is_agent = false;
        shell.title = None;
        assert_eq!(renames(&[pane("%1"), shell]), 1);
        assert_eq!(renames(&[pane("%1"), pane("%2")]), 0);
        assert_eq!(renames(&[pane("%1"), pane("%1")]), 1);
        let mut pending = pane("%2");
        pending.title = None;
        assert_eq!(renames(&[pane("%1"), pending]), 0);
    }

    #[test]
    fn manual_names_stay_protected_and_owned_names_can_update() {
        let mut p = pane("%1");
        p.automatic_rename = false;
        assert_eq!(renames(&[p]), 0);
        let mut p = pane("%1");
        p.automatic_rename = false;
        p.last_window_title = "zsh";
        assert_eq!(renames(&[p]), 1);
        let mut p = pane("%1");
        p.manual_window_name = true;
        p.last_window_title = "zsh";
        assert_eq!(renames(&[p]), 0);
        let mut p = pane("%1");
        p.last_window_title = "Previous generated name";
        assert_eq!(renames(&[p]), 0);
    }

    #[test]
    fn pane_labels_clear_on_exit_and_escape_tmux_formats() {
        let mut p = pane("%1");
        p.title = Some("Fix #{pane_id} #[fg=red]".to_string());
        let commands = title_commands(&[p]);
        assert_eq!(commands[0].last().unwrap(), "Fix ##{pane_id} ##[fg=red]");
        let mut p = pane("%1");
        p.is_agent = false;
        p.title = None;
        p.cached_title = "Old title";
        let commands = title_commands(&[p]);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].last().unwrap(), "");
        assert_eq!(clean_title(" \u{1b}Hello\n ").as_deref(), Some("Hello"));
    }

    #[test]
    fn real_tmux_hook_preserves_explicit_renames() {
        struct Server(std::path::PathBuf);
        impl Server {
            fn run(&self, args: &[&str]) -> String {
                let output = std::process::Command::new("tmux")
                    .arg("-S")
                    .arg(&self.0)
                    .args(args)
                    .output()
                    .expect("tmux");
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout)
                    .expect("utf8")
                    .trim_end()
                    .to_string()
            }
        }
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux")
                    .arg("-S")
                    .arg(&self.0)
                    .arg("kill-server")
                    .output();
            }
        }
        let dir = tempfile::tempdir().expect("directory");
        let server = Server(dir.path().join("tmux.sock"));
        server.run(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "titles",
            "-n",
            "zsh",
        ]);
        server.run(&[
            "set-hook",
            "-g",
            "after-rename-window[111]",
            MANUAL_RENAME_HOOK,
        ]);
        let mut p = pane("%0");
        p.window_id = "@0";
        let commands = title_commands(&[p]);
        let mut args = Vec::new();
        for cmd in &commands {
            if !args.is_empty() {
                args.push(";");
            }
            args.extend(cmd.iter().map(String::as_str));
        }
        server.run(&args);
        assert_eq!(
            server.run(&[
                "display-message",
                "-p",
                "#{window_name}|#{@clawtab-manual-window-name}|#{automatic-rename}"
            ]),
            "Repair state||0"
        );
        for title in ["Task ;", "-a title", "Fix #{pane_id}"] {
            let mut p = pane("%0");
            p.window_id = "@0";
            p.title = Some(title.to_string());
            let commands = title_commands(&[p]);
            let mut args = Vec::new();
            for cmd in &commands {
                if !args.is_empty() {
                    args.push(";");
                }
                args.extend(cmd.iter().map(String::as_str));
            }
            server.run(&args);
            assert_eq!(
                server.run(&["display-message", "-p", "#{window_name}"]),
                title
            );
        }
        assert_eq!(
            server.run(&["display-message", "-p", "#{@clawtab-title-renaming}"]),
            ""
        );
        // Hooks must retain the renamed window's target in the background.
        server.run(&["new-window", "-n", "other"]);
        // Choosing even the same title explicitly opts out of future renames.
        server.run(&["rename-window", "-t", "@0", "Fix ##{pane_id}"]);
        assert_eq!(
            server.run(&[
                "display-message",
                "-p",
                "-t",
                "@0",
                "#{@clawtab-manual-window-name}"
            ]),
            "1"
        );
        assert_eq!(
            server.run(&[
                "display-message",
                "-p",
                "-t",
                "@1",
                "#{@clawtab-manual-window-name}"
            ]),
            ""
        );
    }
}
