use std::collections::HashMap;
use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph};

use clawdtab_lib::ipc::{self, IpcCommand, IpcResponse};

struct App {
    jobs: Vec<String>,
    statuses: HashMap<String, serde_json::Value>,
    list_state: ListState,
    message: Option<String>,
    running: bool,
}

impl App {
    fn new() -> Self {
        Self {
            jobs: Vec::new(),
            statuses: HashMap::new(),
            list_state: ListState::default(),
            message: None,
            running: true,
        }
    }

    fn selected_job(&self) -> Option<&String> {
        self.list_state.selected().and_then(|i| self.jobs.get(i))
    }

    fn next(&mut self) {
        if self.jobs.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => (i + 1) % self.jobs.len(),
            None => 0,
        };
        self.list_state.select(Some(i));
    }

    fn prev(&mut self) {
        if self.jobs.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i == 0 {
                    self.jobs.len() - 1
                } else {
                    i - 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // Test connection first
    match ipc::send_command(IpcCommand::Ping).await {
        Ok(IpcResponse::Pong) => {}
        _ => {
            eprintln!("ClawdTab is not running. Start the GUI app first.");
            std::process::exit(1);
        }
    }

    let mut app = App::new();
    refresh_data(&mut app).await;
    if !app.jobs.is_empty() {
        app.list_state.select(Some(0));
    }

    // Setup terminal
    enable_raw_mode().expect("Failed to enable raw mode");
    io::stdout()
        .execute(EnterAlternateScreen)
        .expect("Failed to enter alternate screen");
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend).expect("Failed to create terminal");

    // Main loop
    let mut last_refresh = std::time::Instant::now();

    while app.running {
        terminal.draw(|f| draw(f, &mut app)).expect("Failed to draw");

        // Poll for events with timeout
        if event::poll(Duration::from_millis(200)).expect("Failed to poll") {
            if let Event::Key(key) = event::read().expect("Failed to read event") {
                if key.kind == KeyEventKind::Press {
                    handle_key(&mut app, key.code).await;
                }
            }
        }

        // Auto-refresh every 5s
        if last_refresh.elapsed() >= Duration::from_secs(5) {
            refresh_data(&mut app).await;
            last_refresh = std::time::Instant::now();
        }
    }

    // Restore terminal
    disable_raw_mode().expect("Failed to disable raw mode");
    io::stdout()
        .execute(LeaveAlternateScreen)
        .expect("Failed to leave alternate screen");
}

async fn refresh_data(app: &mut App) {
    if let Ok(IpcResponse::Jobs(jobs)) = ipc::send_command(IpcCommand::ListJobs).await {
        app.jobs = jobs;
    }
    if let Ok(IpcResponse::Status(statuses)) = ipc::send_command(IpcCommand::GetStatus).await {
        app.statuses = statuses
            .into_iter()
            .map(|(k, v)| (k, serde_json::to_value(v).unwrap_or_default()))
            .collect();
    }
}

async fn handle_key(app: &mut App, key: KeyCode) {
    match key {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.running = false;
        }
        KeyCode::Char('j') | KeyCode::Down => {
            app.next();
            app.message = None;
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.prev();
            app.message = None;
        }
        KeyCode::Char('r') => {
            if let Some(name) = app.selected_job().cloned() {
                match ipc::send_command(IpcCommand::RunJob { name: name.clone() }).await {
                    Ok(IpcResponse::Ok) => {
                        app.message = Some(format!("Started: {}", name));
                    }
                    Ok(IpcResponse::Error(e)) => {
                        app.message = Some(format!("Error: {}", e));
                    }
                    Err(e) => {
                        app.message = Some(format!("IPC error: {}", e));
                    }
                    _ => {}
                }
            }
        }
        KeyCode::Char('p') => {
            if let Some(name) = app.selected_job().cloned() {
                match ipc::send_command(IpcCommand::PauseJob { name: name.clone() }).await {
                    Ok(IpcResponse::Ok) => {
                        app.message = Some(format!("Paused: {}", name));
                    }
                    Ok(IpcResponse::Error(e)) => {
                        app.message = Some(format!("Error: {}", e));
                    }
                    _ => {}
                }
            }
        }
        KeyCode::Char('u') => {
            if let Some(name) = app.selected_job().cloned() {
                match ipc::send_command(IpcCommand::ResumeJob { name: name.clone() }).await {
                    Ok(IpcResponse::Ok) => {
                        app.message = Some(format!("Resumed: {}", name));
                    }
                    Ok(IpcResponse::Error(e)) => {
                        app.message = Some(format!("Error: {}", e));
                    }
                    _ => {}
                }
            }
        }
        KeyCode::Char('R') => {
            if let Some(name) = app.selected_job().cloned() {
                match ipc::send_command(IpcCommand::RestartJob { name: name.clone() }).await {
                    Ok(IpcResponse::Ok) => {
                        app.message = Some(format!("Restarted: {}", name));
                    }
                    Ok(IpcResponse::Error(e)) => {
                        app.message = Some(format!("Error: {}", e));
                    }
                    _ => {}
                }
            }
        }
        KeyCode::Char('s') => {
            refresh_data(app).await;
            app.message = Some("Refreshed".to_string());
        }
        KeyCode::Char('S') => {
            // Open GUI settings
            let _ = ipc::send_command(IpcCommand::OpenSettings).await;
            let _ = std::process::Command::new("open")
                .args(["-a", "ClawdTab"])
                .spawn();
            app.message = Some("Opening settings...".to_string());
        }
        KeyCode::Char('o') => {
            // Open tmux session
            if let Some(name) = app.selected_job().cloned() {
                let session = "tgs"; // default session
                let window = format!("cm-{}", name);
                let _ = std::process::Command::new("tmux")
                    .args(["select-window", "-t", &format!("{}:{}", session, window)])
                    .spawn();
                app.message = Some(format!("Focusing: {}", window));
            }
        }
        _ => {}
    }
}

fn draw(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(f.area());

    // Job list with statuses
    let items: Vec<ListItem> = app
        .jobs
        .iter()
        .map(|name| {
            let status = app
                .statuses
                .get(name)
                .and_then(|v| v.get("state"))
                .and_then(|s| s.as_str())
                .unwrap_or("idle");

            let (indicator, style) = match status {
                "running" => (">>", Style::default().fg(Color::Yellow)),
                "success" => ("ok", Style::default().fg(Color::Green)),
                "failed" => ("!!", Style::default().fg(Color::Red)),
                "paused" => ("||", Style::default().fg(Color::Cyan)),
                _ => ("--", Style::default().fg(Color::DarkGray)),
            };

            ListItem::new(Line::from(vec![
                Span::styled(format!(" {} ", indicator), style),
                Span::raw(name),
            ]))
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" ClawdTab "),
        )
        .highlight_style(Style::default().bg(Color::DarkGray).bold())
        .highlight_symbol("> ");

    f.render_stateful_widget(list, chunks[0], &mut app.list_state);

    // Message bar
    let msg = app.message.as_deref().unwrap_or("");
    let msg_widget = Paragraph::new(msg)
        .block(Block::default().borders(Borders::ALL).title(" Status "));
    f.render_widget(msg_widget, chunks[1]);

    // Keybindings
    let keys = Paragraph::new(
        " q:quit  r:run  p:pause  u:resume  R:restart  s:refresh  S:settings  o:tmux  j/k:nav",
    )
    .style(Style::default().fg(Color::DarkGray));
    f.render_widget(keys, chunks[2]);
}
