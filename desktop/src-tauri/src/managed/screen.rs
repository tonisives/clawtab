use super::{InputModes, Size};
use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::Dimensions,
    index::{Column, Line, Point},
    term::{cell::Flags, Config, TermMode},
    vte::ansi::{Color, NamedColor, Processor, Rgb},
    Term,
};
use parking_lot::Mutex;
use std::fmt::Write;
use std::sync::Arc;

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        usize::from(self.rows)
    }
    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }
    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

#[derive(Clone)]
struct Events(Arc<Mutex<Vec<Event>>>);
impl EventListener for Events {
    fn send_event(&self, event: Event) {
        self.0.lock().push(event);
    }
}

pub(super) struct Screen {
    term: Term<Events>,
    parser: Processor,
    events: Events,
    pub size: Size,
    pub title: Option<String>,
}

impl Screen {
    pub fn new(size: Size) -> Self {
        let events = Events(Arc::new(Mutex::new(Vec::new())));
        let term = Term::new(
            Config {
                scrolling_history: 10000,
                ..Config::default()
            },
            &size,
            events.clone(),
        );
        Self {
            term,
            parser: Processor::new(),
            events,
            size,
            title: None,
        }
    }

    /// Only the owner answers terminal queries; viewers never feed replies back.
    pub fn process(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.parser.advance(&mut self.term, bytes);
        let mut reply = Vec::new();
        for event in self.events.0.lock().drain(..) {
            let text = match event {
                Event::Title(title) => {
                    self.title = Some(title);
                    continue;
                }
                Event::ResetTitle => {
                    self.title = None;
                    continue;
                }
                Event::PtyWrite(text) => text,
                Event::TextAreaSizeRequest(format) => format(WindowSize {
                    num_lines: self.size.rows,
                    num_cols: self.size.cols,
                    cell_width: 0,
                    cell_height: 0,
                }),
                Event::ColorRequest(index, format) => format(self.term.colors()[index].unwrap_or(
                    if index == NamedColor::Background as usize {
                        Rgb { r: 0, g: 0, b: 0 }
                    } else {
                        Rgb {
                            r: 229,
                            g: 229,
                            b: 229,
                        }
                    },
                )),
                _ => continue,
            };
            reply.extend_from_slice(text.as_bytes());
        }
        reply
    }

    pub fn resize(&mut self, size: Size) {
        self.term.resize(size);
        self.size = size;
    }

    pub fn cursor_row(&self) -> u16 {
        self.term.grid().cursor.point.line.0.max(0) as u16
    }

    pub fn capture(&self, history: bool, ansi: bool, lines: u32) -> String {
        let start = if history {
            -(self.term.history_size() as i32)
        } else {
            0
        };
        let end = i32::from(self.size.rows);
        let start = start.max(end.saturating_sub(lines.min(10300) as i32));
        (start..end)
            .map(|line| self.row(Line(line), ansi, self.size.cols))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn row(&self, line: Line, ansi: bool, cols: u16) -> String {
        let mut result = String::new();
        let mut previous = None;
        for col in 0..usize::from(cols.min(self.size.cols)) {
            let cell = &self.term.grid()[Point::new(line, Column(col))];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let attributes = (
                cell.fg,
                cell.bg,
                cell.flags & !(Flags::WRAPLINE | Flags::WIDE_CHAR),
            );
            if ansi && previous != Some(attributes) {
                result.push_str("\x1b[0m");
                color(&mut result, cell.fg, false);
                color(&mut result, cell.bg, true);
                for (flag, code) in [
                    (Flags::BOLD, 1),
                    (Flags::DIM, 2),
                    (Flags::ITALIC, 3),
                    (Flags::ALL_UNDERLINES, 4),
                    (Flags::INVERSE, 7),
                    (Flags::HIDDEN, 8),
                    (Flags::STRIKEOUT, 9),
                ] {
                    if cell.flags.intersects(flag) {
                        let _ = write!(result, "\x1b[{code}m");
                    }
                }
                previous = Some(attributes);
            }
            result.push(if cell.c.is_control() { ' ' } else { cell.c });
            if let Some(extra) = cell.zerowidth() {
                result.extend(extra.iter().filter(|c| !c.is_control()));
            }
        }
        if ansi {
            result.push_str("\x1b[0m");
            result
        } else {
            result.trim_end().to_owned()
        }
    }

    pub fn input_modes(&self) -> InputModes {
        let mode = self.term.mode();
        InputModes {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            mouse: mode.intersects(TermMode::MOUSE_MODE),
            mouse_motion: mode.contains(TermMode::MOUSE_MOTION),
            mouse_drag: mode.contains(TermMode::MOUSE_DRAG),
        }
    }

    pub fn frame(&self) -> String {
        self.frame_viewport(self.size)
    }

    pub fn frame_viewport(&self, viewport: Size) -> String {
        // These are rendered cells, never replayed application control sequences.
        let mut out = String::from("\x1b[?2026h\x1b[?25l\x1b[?6l\x1b[4l\x1b[r\x1b[?7l");
        for row in 0..viewport.rows {
            let content = if row < self.size.rows {
                self.row(Line(i32::from(row)), true, viewport.cols)
            } else {
                String::new()
            };
            let _ = write!(out, "\x1b[{};1H\x1b[2K{}", row + 1, content);
        }
        out.push_str("\x1b[0m\x1b[?7h");
        let mode = self.term.mode();
        for (flag, code) in [
            (TermMode::APP_CURSOR, 1),
            (TermMode::BRACKETED_PASTE, 2004),
            (TermMode::MOUSE_REPORT_CLICK, 1000),
            (TermMode::MOUSE_DRAG, 1002),
            (TermMode::MOUSE_MOTION, 1003),
            (TermMode::SGR_MOUSE, 1006),
            (TermMode::SHOW_CURSOR, 25),
        ] {
            let _ = write!(
                out,
                "\x1b[?{code}{}",
                if mode.contains(flag) { 'h' } else { 'l' }
            );
        }
        let point = self.term.grid().cursor.point;
        let _ = write!(
            out,
            "\x1b[{};{}H\x1b[?2026l",
            (point.line.0.max(0) + 1).min(i32::from(viewport.rows)),
            (point.column.0 + 1).min(usize::from(viewport.cols))
        );
        out
    }
}

fn color(out: &mut String, color: Color, background: bool) {
    let code = if background { 48 } else { 38 };
    match color {
        Color::Spec(rgb) => {
            let _ = write!(out, "\x1b[{code};2;{};{};{}m", rgb.r, rgb.g, rgb.b);
        }
        Color::Indexed(index) => {
            let _ = write!(out, "\x1b[{code};5;{index}m");
        }
        Color::Named(name) if (name as usize) < 16 => {
            let _ = write!(out, "\x1b[{code};5;{}m", name as usize);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_split_terminal_title_updates() {
        let mut screen = Screen::new(Size::new(80, 24));
        screen.process(b"\x1b]0;First");
        screen.process(b" task | project\x07");
        assert_eq!(screen.title.as_deref(), Some("First task | project"));
        screen.process(b"\x1b]2;Renamed | project\x1b\\");
        assert_eq!(screen.title.as_deref(), Some("Renamed | project"));
    }

    #[test]
    fn capture_and_frame_preserve_cells_and_cursor() {
        let mut screen = Screen::new(Size::new(20, 5));
        screen.process("hello\r\n\x1b[31m世界\x1b[0m".as_bytes());
        let mut viewer = Screen::new(screen.size);
        viewer.process(screen.frame().as_bytes());
        assert_eq!(
            viewer.capture(false, false, 5),
            screen.capture(false, false, 5)
        );
        assert_eq!(viewer.cursor_row(), screen.cursor_row());
    }

    #[test]
    fn resize_reflows_and_alternate_screen_survives() {
        let mut screen = Screen::new(Size::new(20, 5));
        screen.process(b"abcdefghijklmnopqr");
        screen.resize(Size::new(10, 5));
        screen.resize(Size::new(20, 5));
        assert!(screen
            .capture(true, false, 100)
            .contains("abcdefghijklmnopqr"));
        let primary = screen.capture(false, false, 5);
        screen.process(b"\x1b[?1049hOTHER");
        assert!(screen.capture(false, false, 5).contains("OTHER"));
        screen.process(b"\x1b[?1049l");
        assert_eq!(screen.capture(false, false, 5), primary);
    }

    #[test]
    fn terminal_queries_have_one_owner_reply() {
        let mut screen = Screen::new(Size::default());
        assert_eq!(screen.process(b"abc\x1b[6n"), b"\x1b[1;4R");
        assert!(!screen.frame().contains("\x1b[6n"));
    }
}
