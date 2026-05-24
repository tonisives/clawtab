use std::collections::HashMap;
use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph};

use clawtab_lib::config::jobs::JobStatus;
use clawtab_lib::ipc::{self, IpcCommand, IpcResponse, PaneEntry};

#[derive(Copy, Clone, PartialEq, Eq)]
enum Section {
    Panes,
    Jobs,
}

struct App {
    panes: Vec<PaneEntry>,
    jobs: Vec<String>,
    statuses: HashMap<String, JobStatus>,
    pane_state: ListState,
    job_state: ListState,
    focus: Section,
    filter: String,
    message: Option<String>,
    running: bool,
    invoking_pane: Option<String>,
}

impl App {
    fn new(invoking_pane: Option<String>) -> Self {
        Self {
            panes: Vec::new(),
            jobs: Vec::new(),
            statuses: HashMap::new(),
            pane_state: ListState::default(),
            job_state: ListState::default(),
            focus: Section::Panes,
            filter: String::new(),
            message: None,
            running: true,
            invoking_pane,
        }
    }

    fn filtered_panes(&self) -> Vec<&PaneEntry> {
        let f = self.filter.to_lowercase();
        self.panes
            .iter()
            .filter(|p| {
                if f.is_empty() {
                    return true;
                }
                let hay = format!(
                    "{} {} {} {}",
                    p.session, p.window_name, p.current_command, p.pane_id
                )
                .to_lowercase();
                hay.contains(&f)
            })
            .collect()
    }

    fn filtered_jobs(&self) -> Vec<&String> {
        let f = self.filter.to_lowercase();
        self.jobs
            .iter()
            .filter(|n| f.is_empty() || n.to_lowercase().contains(&f))
            .collect()
    }

    fn move_focus(&mut self, delta: i32) {
        let len = match self.focus {
            Section::Panes => self.filtered_panes().len(),
            Section::Jobs => self.filtered_jobs().len(),
        };
        if len == 0 {
            return;
        }
        let state = match self.focus {
            Section::Panes => &mut self.pane_state,
            Section::Jobs => &mut self.job_state,
        };
        let cur = state.selected().unwrap_or(0) as i32;
        let next = ((cur + delta).rem_euclid(len as i32)) as usize;
        state.select(Some(next));
    }

    fn switch_section(&mut self) {
        self.focus = match self.focus {
            Section::Panes => Section::Jobs,
            Section::Jobs => Section::Panes,
        };
        self.ensure_selection();
    }

    fn ensure_selection(&mut self) {
        match self.focus {
            Section::Panes => {
                if self.pane_state.selected().is_none() && !self.filtered_panes().is_empty() {
                    self.pane_state.select(Some(0));
                }
            }
            Section::Jobs => {
                if self.job_state.selected().is_none() && !self.filtered_jobs().is_empty() {
                    self.job_state.select(Some(0));
                }
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let invoking_pane = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--pane")
        .map(|w| w[1].clone());

    match ipc::send_command(IpcCommand::Ping).await {
        Ok(IpcResponse::Pong) => {}
        _ => {
            eprintln!("ClawTab daemon is not running.");
            std::process::exit(1);
        }
    }

    let mut app = App::new(invoking_pane);
    refresh(&mut app).await;
    app.ensure_selection();

    enable_raw_mode().expect("raw mode");
    io::stdout()
        .execute(EnterAlternateScreen)
        .expect("alt screen");
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend).expect("terminal");

    let mut last_refresh = std::time::Instant::now();
    while app.running {
        terminal.draw(|f| draw(f, &mut app)).expect("draw");

        if event::poll(Duration::from_millis(150)).expect("poll") {
            if let Event::Key(key) = event::read().expect("read") {
                if key.kind == KeyEventKind::Press {
                    handle_key(&mut app, key.code, key.modifiers).await;
                }
            }
        }

        if last_refresh.elapsed() >= Duration::from_secs(5) {
            refresh(&mut app).await;
            last_refresh = std::time::Instant::now();
        }
    }

    disable_raw_mode().expect("disable raw");
    io::stdout()
        .execute(LeaveAlternateScreen)
        .expect("leave alt");
}

async fn refresh(app: &mut App) {
    if let Ok(IpcResponse::AllPanes(panes)) = ipc::send_command(IpcCommand::ListAllPanes).await {
        app.panes = panes;
    }
    if let Ok(IpcResponse::Jobs(jobs)) = ipc::send_command(IpcCommand::ListJobs).await {
        app.jobs = jobs;
    }
    if let Ok(IpcResponse::Status(s)) = ipc::send_command(IpcCommand::GetStatus).await {
        app.statuses = s;
    }
}

async fn handle_key(app: &mut App, key: KeyCode, mods: KeyModifiers) {
    match key {
        KeyCode::Esc => app.running = false,
        KeyCode::Char('c') if mods.contains(KeyModifiers::CONTROL) => app.running = false,
        KeyCode::Tab => app.switch_section(),
        KeyCode::Down => app.move_focus(1),
        KeyCode::Up => app.move_focus(-1),
        KeyCode::Backspace => {
            app.filter.pop();
            app.pane_state.select(None);
            app.job_state.select(None);
            app.ensure_selection();
        }
        KeyCode::Enter => activate(app).await,
        KeyCode::Char('e') if app.focus == Section::Jobs => open_folder(app).await,
        KeyCode::Char(c) => {
            app.filter.push(c);
            app.pane_state.select(None);
            app.job_state.select(None);
            app.ensure_selection();
        }
        _ => {}
    }
}

async fn activate(app: &mut App) {
    match app.focus {
        Section::Panes => {
            let target = {
                let panes = app.filtered_panes();
                let idx = match app.pane_state.selected() {
                    Some(i) => i,
                    None => return,
                };
                panes.get(idx).map(|p| (*p).clone())
            };
            if let Some(p) = target {
                let _ = std::process::Command::new("tmux")
                    .args(["switch-client", "-t", &p.session])
                    .status();
                let _ = std::process::Command::new("tmux")
                    .args(["select-window", "-t", &p.window_id])
                    .status();
                let _ = std::process::Command::new("tmux")
                    .args(["select-pane", "-t", &p.pane_id])
                    .status();
                app.running = false;
            }
        }
        Section::Jobs => {
            let name = {
                let jobs = app.filtered_jobs();
                jobs.get(app.job_state.selected().unwrap_or(0))
                    .map(|n| (*n).clone())
            };
            if let Some(n) = name {
                match ipc::send_command(IpcCommand::RunJob { name: n.clone() }).await {
                    Ok(IpcResponse::Ok) => app.message = Some(format!("Started: {}", n)),
                    Ok(IpcResponse::Error(e)) => app.message = Some(format!("Error: {}", e)),
                    Err(e) => app.message = Some(format!("IPC: {}", e)),
                    _ => {}
                }
            }
        }
    }
}

async fn open_folder(app: &mut App) {
    let name = {
        let jobs = app.filtered_jobs();
        jobs.get(app.job_state.selected().unwrap_or(0))
            .map(|n| (*n).clone())
    };
    if let Some(n) = name {
        match ipc::send_command(IpcCommand::OpenJobFolder { name: n.clone() }).await {
            Ok(IpcResponse::Ok) => {
                app.message = Some(format!("Opened: {}", n));
                app.running = false;
            }
            Ok(IpcResponse::Error(e)) => app.message = Some(format!("Error: {}", e)),
            Err(e) => app.message = Some(format!("IPC: {}", e)),
            _ => {}
        }
    }
}

fn draw(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Percentage(55),
            Constraint::Min(5),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(f.area());

    let filter_label = if app.filter.is_empty() {
        " filter (type to search) ".to_string()
    } else {
        format!(" filter: {} ", app.filter)
    };
    let filter = Paragraph::new(app.filter.as_str())
        .block(Block::default().borders(Borders::ALL).title(filter_label));
    f.render_widget(filter, chunks[0]);

    let panes = app.filtered_panes();
    let invoking = app.invoking_pane.clone();
    let pane_items: Vec<ListItem> = panes
        .iter()
        .map(|p| {
            let marker = if invoking.as_deref() == Some(&p.pane_id) {
                "* "
            } else {
                "  "
            };
            ListItem::new(Line::from(vec![
                Span::styled(marker, Style::default().fg(Color::Yellow)),
                Span::styled(
                    format!("{}:{}", p.session, p.window_name),
                    Style::default().fg(Color::Cyan),
                ),
                Span::raw("  "),
                Span::styled(p.current_command.clone(), Style::default().fg(Color::Green)),
                Span::raw("  "),
                Span::styled(p.pane_id.clone(), Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let pane_title = format!(
        " Panes ({}){} ",
        panes.len(),
        if app.focus == Section::Panes {
            " <"
        } else {
            ""
        }
    );
    let pane_list = List::new(pane_items)
        .block(Block::default().borders(Borders::ALL).title(pane_title))
        .highlight_style(Style::default().bg(Color::DarkGray).bold())
        .highlight_symbol("> ");
    f.render_stateful_widget(pane_list, chunks[1], &mut app.pane_state);

    let jobs = app.filtered_jobs();
    let job_items: Vec<ListItem> = jobs
        .iter()
        .map(|name| {
            let (mark, style) = match app.statuses.get(*name) {
                Some(JobStatus::Running { .. }) => (">>", Style::default().fg(Color::Yellow)),
                Some(JobStatus::Success { .. }) => ("ok", Style::default().fg(Color::Green)),
                Some(JobStatus::Failed { .. }) => ("!!", Style::default().fg(Color::Red)),
                Some(JobStatus::Paused) => ("||", Style::default().fg(Color::Cyan)),
                _ => ("--", Style::default().fg(Color::DarkGray)),
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!(" {} ", mark), style),
                Span::raw((*name).clone()),
            ]))
        })
        .collect();
    let job_title = format!(
        " Jobs ({}){} ",
        jobs.len(),
        if app.focus == Section::Jobs { " <" } else { "" }
    );
    let job_list = List::new(job_items)
        .block(Block::default().borders(Borders::ALL).title(job_title))
        .highlight_style(Style::default().bg(Color::DarkGray).bold())
        .highlight_symbol("> ");
    f.render_stateful_widget(job_list, chunks[2], &mut app.job_state);

    let msg = app.message.as_deref().unwrap_or("");
    f.render_widget(
        Paragraph::new(msg).style(Style::default().fg(Color::Yellow)),
        chunks[3],
    );

    let keys = if app.focus == Section::Jobs {
        " enter:run  e:open folder  tab:switch  esc:quit "
    } else {
        " enter:switch  tab:switch  esc:quit "
    };
    f.render_widget(
        Paragraph::new(keys).style(Style::default().fg(Color::DarkGray)),
        chunks[4],
    );
}
