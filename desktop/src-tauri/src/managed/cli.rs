use super::{client, store, InputModes, Launch, Request, Response, SessionInfo, Size, Status};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute, terminal,
};
use std::io::{IsTerminal, Write};
use std::time::Duration;

pub fn run_cli(args: &[String]) -> Result<(), String> {
    let action = args.first().map(String::as_str).unwrap_or("help");
    match action {
        #[cfg(windows)]
        "_exec" => {
            // Rust's process launcher handles .cmd quoting. ConPTY itself can
            // only CreateProcess a native executable, so batch shims enter here.
            let path = store::directory(required(args, 1)?)?.join("command.json");
            let launch: Launch = store::read(&path)?;
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            let program = which::which_in(&launch.program, std::env::var_os("PATH"), &launch.cwd)
                .map_err(|e| e.to_string())?;
            let status = std::process::Command::new(program)
                .args(&launch.args)
                .current_dir(&launch.cwd)
                .status()
                .map_err(|e| e.to_string())?;
            std::process::exit(status.code().unwrap_or(1));
        }
        "_serve" => {
            let id = required(args, 1)?;
            let launch = client::read_message(&mut std::io::stdin())?;
            let result = super::owner::serve(id, launch);
            if let Err(error) = &result {
                let _ = store::save(&store::directory(id)?.join("error.json"), error);
            }
            result
        }
        "start" => start(args),
        "list" => {
            let sessions = super::list()?;
            if args.iter().any(|arg| arg == "--json") {
                println!(
                    "{}",
                    serde_json::to_string(&sessions).map_err(|e| e.to_string())?
                );
            } else {
                for session in sessions {
                    println!(
                        "{}\t{:?}\t{}\t{}",
                        session.id, session.status, session.launch.program, session.launch.cwd
                    );
                }
            }
            Ok(())
        }
        "attach" => attach(required(args, 1)?, false),
        "stop" => {
            super::request(required(args, 1)?, Request::Stop)?;
            Ok(())
        }
        "capture" => capture(args),
        "resume" => {
            let id = required(args, 1)?;
            let Response::Info { session } = super::request(id, Request::Info)? else {
                return Err("session metadata unavailable".into());
            };
            if session.status == Status::Running {
                return attach(id, false);
            }
            let launch = resume_launch(session)?;
            client::launch_with_id(&client::launcher_path()?, id, launch, &[])?;
            attach(id, true)
        }
        "detach" => Err("press Ctrl+] then d in the attached terminal to detach".into()),
        "help" | "--help" | "-h" => {
            println!("Usage: cwtctl session start [--detached] [--close-with-terminal | --keep-running] -- <program> [args]\n       cwtctl session list [--json]\n       cwtctl session attach <id>\n       cwtctl session capture <id> [--history] [--ansi]\n       cwtctl session stop <id>\n       cwtctl session resume <id>\n\nIn an attached terminal, Ctrl+] then d detaches; Ctrl+] twice sends Ctrl+].\nClosing the terminal leaves its agent running unless --close-with-terminal is set.");
            Ok(())
        }
        _ => Err(format!("unknown session command: {action}")),
    }
}

fn capture(args: &[String]) -> Result<(), String> {
    let response = super::request(
        required(args, 1)?,
        Request::Capture {
            history: args.iter().any(|arg| arg == "--history"),
            ansi: args.iter().any(|arg| arg == "--ansi"),
            lines: 10300,
        },
    )?;
    if let Response::Capture { content } = response {
        println!("{content}");
    }
    Ok(())
}

fn start(args: &[String]) -> Result<(), String> {
    let split = args.iter().position(|arg| arg == "--").ok_or(
        "usage: cwtctl session start [--detached] [--close-with-terminal] -- <program> [args]",
    )?;
    let program = required(args, split + 1)?.to_owned();
    let mut close_with_terminal =
        crate::config::settings::AppSettings::load().managed_close_with_terminal;
    let mut detached = false;
    for option in &args[1..split] {
        match option.as_str() {
            "--detached" => detached = true,
            "--close-with-terminal" => close_with_terminal = true,
            "--keep-running" => close_with_terminal = false,
            _ => return Err(format!("unknown session option: {option}")),
        }
    }
    if detached && close_with_terminal {
        return Err("--close-with-terminal requires an attached terminal".into());
    }
    if !detached && !std::io::stdin().is_terminal() {
        return Err("use --detached when launching without a terminal".into());
    }
    let provider = provider_for_program(&program);
    let launch = Launch {
        program,
        args: args[split + 2..].to_vec(),
        cwd: std::env::current_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
        size: local_size(),
        close_with_terminal,
        provider,
        conversation_id: None,
        metadata: Default::default(),
    };
    let info = super::launch(launch, &[])?;
    eprintln!("{}", info.id);
    if detached {
        Ok(())
    } else {
        attach(&info.id, true)
    }
}

fn required(args: &[String], index: usize) -> Result<&str, String> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| "missing session argument; see cwtctl session help".into())
}

fn provider_for_program(program: &str) -> String {
    let name = std::path::Path::new(program)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    match name.to_ascii_lowercase().as_str() {
        "claude" | "codex" | "opencode" => name.to_ascii_lowercase(),
        "agy" => "antigravity".into(),
        _ => "shell".into(),
    }
}

fn resume_launch(info: SessionInfo) -> Result<Launch, String> {
    let mut launch = info.launch;
    let conversation = launch
        .conversation_id
        .as_deref()
        .ok_or("this session has no saved provider conversation to resume")?;
    launch.args = match launch.provider.as_str() {
        "claude" => vec!["-r".into(), conversation.into()],
        "codex" => vec!["resume".into(), conversation.into()],
        "opencode" => vec!["-s".into(), conversation.into()],
        "antigravity" => vec!["--conversation".into(), conversation.into()],
        _ => return Err("this command does not support conversation resume".into()),
    };
    Ok(launch)
}

fn local_size() -> Size {
    let (cols, rows) = terminal::size().unwrap_or((80, 25));
    Size::new(cols, rows)
}

struct TerminalGuard;
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = write!(
            std::io::stdout(),
            "\x1b[0m\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l"
        );
        let _ = execute!(
            std::io::stdout(),
            cursor::Show,
            terminal::LeaveAlternateScreen
        );
    }
}

pub fn attach(id: &str, origin: bool) -> Result<(), String> {
    if !std::io::stdin().is_terminal() {
        return Err("attach requires an interactive terminal".into());
    }
    let mut client = super::connect(id)?;
    client.request(Request::Attach {
        viewer: uuid::Uuid::new_v4().to_string(),
        size: local_size(),
        origin,
    })?;
    let _guard = enter_terminal()?;
    let mut after = None;
    let mut prefix = false;
    let mut previous_size = None;
    let mut input_modes = InputModes::default();
    loop {
        match client.request(Request::Snapshot { after })? {
            Response::Snapshot { snapshot } => {
                input_modes = snapshot.input_modes.clone();
                render(&snapshot, &mut previous_size)?;
                after = Some(snapshot.revision);
                if snapshot.status != Status::Running {
                    break;
                }
            }
            Response::Unchanged => {}
            _ => return Err("invalid viewer response".into()),
        }
        if !event::poll(Duration::from_millis(30)).map_err(|e| e.to_string())? {
            continue;
        }
        match event::read().map_err(|e| e.to_string())? {
            Event::Key(key) if key.kind != event::KeyEventKind::Release => {
                if prefix {
                    prefix = false;
                    if key.code == KeyCode::Char('d') {
                        client.request(Request::Detach)?;
                        return Ok(());
                    }
                    client.request(Request::LocalInput { data: vec![29] })?;
                    if is_detach_prefix(key) {
                        continue;
                    }
                } else if is_detach_prefix(key) {
                    prefix = true;
                    continue;
                }
                let data = encode_key(key, &input_modes);
                if !data.is_empty() {
                    client.request(Request::LocalInput { data })?;
                }
            }
            Event::Paste(text) => {
                let data = if input_modes.bracketed_paste {
                    format!("\x1b[200~{text}\x1b[201~").into_bytes()
                } else {
                    text.into_bytes()
                };
                client.request(Request::LocalInput { data })?;
            }
            Event::Mouse(mouse) if input_modes.mouse => {
                if let Some(data) = encode_mouse(mouse, &input_modes) {
                    client.request(Request::LocalInput { data })?;
                }
            }
            Event::Resize(_, _) => {
                client.request(Request::LocalResize { size: local_size() })?;
                after = None;
            }
            _ => {}
        }
    }
    Ok(())
}

fn is_detach_prefix(key: KeyEvent) -> bool {
    // Crossterm decodes the legacy Ctrl+] byte (0x1d) as Ctrl+5. Terminals
    // using an extended keyboard protocol can report the bracket directly.
    matches!(key.code, KeyCode::Char(']' | '5')) && key.modifiers.contains(KeyModifiers::CONTROL)
}

fn enter_terminal() -> Result<TerminalGuard, String> {
    terminal::enable_raw_mode().map_err(|e| e.to_string())?;
    let guard = TerminalGuard;
    execute!(
        std::io::stdout(),
        terminal::EnterAlternateScreen,
        terminal::Clear(terminal::ClearType::All)
    )
    .map_err(|e| e.to_string())?;
    Ok(guard)
}

fn render(snapshot: &super::Snapshot, previous_size: &mut Option<Size>) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    if *previous_size != Some(snapshot.size) {
        write!(stdout, "\x1b[2J").map_err(|e| e.to_string())?;
        *previous_size = Some(snapshot.size);
    }
    write!(stdout, "{}\x1b[?2004h", snapshot.ansi).map_err(|e| e.to_string())?;
    render_indicator(
        &mut stdout,
        local_size().cols,
        snapshot.control.holder.is_some(),
    )?;
    stdout.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn render_indicator(
    stdout: &mut impl Write,
    cols: u16,
    remote_control: bool,
) -> Result<(), String> {
    // Overlay one cell without reserving a terminal row or moving the agent cursor.
    let style = if remote_control { "1;36" } else { "2;37" };
    write!(stdout, "\x1b7\x1b[1;{cols}H\x1b[0;{style}mC\x1b[0m\x1b8").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_prefix_accepts_legacy_and_extended_terminal_keys() {
        assert!(is_detach_prefix(KeyEvent::new(
            KeyCode::Char('5'),
            KeyModifiers::CONTROL
        )));
        assert!(is_detach_prefix(KeyEvent::new(
            KeyCode::Char(']'),
            KeyModifiers::CONTROL
        )));
        assert!(!is_detach_prefix(KeyEvent::new(
            KeyCode::Char('5'),
            KeyModifiers::NONE
        )));
    }

    #[test]
    fn indicator_preserves_terminal_content_and_cursor() {
        for remote in [false, true] {
            let mut output = Vec::new();
            render_indicator(&mut output, 80, remote).unwrap();
            let mut terminal = super::super::screen::Screen::new(Size::new(80, 3));
            terminal.process(b"header\r\nbody\r\nfooter\x1b[2;3H");
            terminal.process(&output);
            let text = terminal.capture(false, false, 3);
            let rows = text.lines().collect::<Vec<_>>();
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0].trim_end().chars().last(), Some('C'));
            assert!(rows[0].starts_with("header"));
            assert!(rows[1].starts_with("body"));
            assert!(rows[2].starts_with("footer"));
            assert_eq!(terminal.process(b"\x1b[6n"), b"\x1b[2;3R");
        }
    }
}

fn encode_key(key: KeyEvent, modes: &InputModes) -> Vec<u8> {
    let modifiers = 1
        + u8::from(key.modifiers.contains(KeyModifiers::SHIFT))
        + 2 * u8::from(key.modifiers.contains(KeyModifiers::ALT))
        + 4 * u8::from(key.modifiers.contains(KeyModifiers::CONTROL));
    let cursor = match key.code {
        KeyCode::Up => Some('A'),
        KeyCode::Down => Some('B'),
        KeyCode::Right => Some('C'),
        KeyCode::Left => Some('D'),
        KeyCode::Home => Some('H'),
        KeyCode::End => Some('F'),
        _ => None,
    };
    if let Some(code) = cursor {
        return if modifiers > 1 {
            format!("\x1b[1;{modifiers}{code}")
        } else {
            format!("\x1b{}{code}", if modes.app_cursor { 'O' } else { '[' })
        }
        .into_bytes();
    }
    let tilde = match key.code {
        KeyCode::Insert => Some(2),
        KeyCode::Delete => Some(3),
        KeyCode::PageUp => Some(5),
        KeyCode::PageDown => Some(6),
        KeyCode::F(n @ 5..=12) => Some([15, 17, 18, 19, 20, 21, 23, 24][usize::from(n - 5)]),
        _ => None,
    };
    if let Some(code) = tilde {
        return if modifiers > 1 {
            format!("\x1b[{code};{modifiers}~")
        } else {
            format!("\x1b[{code}~")
        }
        .into_bytes();
    }
    if let KeyCode::F(n @ 1..=4) = key.code {
        let code = char::from(b'P' + n - 1);
        return if modifiers > 1 {
            format!("\x1b[1;{modifiers}{code}")
        } else {
            format!("\x1bO{code}")
        }
        .into_bytes();
    }
    let value = match key.code {
        KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::CONTROL) && c.is_ascii() => {
            return vec![(c.to_ascii_uppercase() as u8) & 0x1f]
        }
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "\r".into(),
        KeyCode::Tab => "\t".into(),
        KeyCode::BackTab => "\x1b[Z".into(),
        KeyCode::Backspace => "\x7f".into(),
        KeyCode::Esc => "\x1b".into(),
        KeyCode::Up => "\x1b[A".into(),
        KeyCode::Down => "\x1b[B".into(),
        KeyCode::Right => "\x1b[C".into(),
        KeyCode::Left => "\x1b[D".into(),
        KeyCode::Home => "\x1b[H".into(),
        KeyCode::End => "\x1b[F".into(),
        KeyCode::Delete => "\x1b[3~".into(),
        KeyCode::Insert => "\x1b[2~".into(),
        KeyCode::PageUp => "\x1b[5~".into(),
        KeyCode::PageDown => "\x1b[6~".into(),
        _ => return Vec::new(),
    };
    if key.modifiers.contains(KeyModifiers::ALT) {
        format!("\x1b{value}").into_bytes()
    } else {
        value.into_bytes()
    }
}

fn encode_mouse(mouse: event::MouseEvent, modes: &InputModes) -> Option<Vec<u8>> {
    use event::{MouseButton, MouseEventKind};
    let (button, release) = match mouse.kind {
        MouseEventKind::Down(b) | MouseEventKind::Up(b) => (
            match b {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
            },
            matches!(mouse.kind, MouseEventKind::Up(_)),
        ),
        MouseEventKind::Drag(b) if modes.mouse_drag || modes.mouse_motion => (
            32 + match b {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
            },
            false,
        ),
        MouseEventKind::Moved if modes.mouse_motion => (35, false),
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        _ => return None,
    };
    let modifier = if mouse.modifiers.contains(KeyModifiers::SHIFT) {
        4
    } else {
        0
    } + if mouse.modifiers.contains(KeyModifiers::ALT) {
        8
    } else {
        0
    } + if mouse.modifiers.contains(KeyModifiers::CONTROL) {
        16
    } else {
        0
    };
    Some(
        format!(
            "\x1b[<{};{};{}{}",
            button + modifier,
            mouse.column + 1,
            mouse.row + 1,
            if release { 'm' } else { 'M' }
        )
        .into_bytes(),
    )
}
