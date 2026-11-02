/// Convert terminal output to notification text, including SGR codes whose ESC
/// byte was removed before the text reached us.
pub fn notification_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']' | 'P' | '^' | '_') => {
                    while let Some(next) = chars.next() {
                        if next == '\x07' || next == '\u{9c}' {
                            break;
                        }
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(first) if ('\x20'..='\x2f').contains(&first) => {
                    for next in chars.by_ref() {
                        if !('\x20'..='\x2f').contains(&next) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\u{9b}' => {
                for next in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&next) {
                        break;
                    }
                }
            }
            '[' => {
                let mut candidate = chars.clone();
                let has_parameters = candidate
                    .peek()
                    .is_some_and(|c| c.is_ascii_digit() || matches!(c, ';' | ':'));
                while candidate
                    .peek()
                    .is_some_and(|c| c.is_ascii_digit() || matches!(c, ';' | ':'))
                {
                    candidate.next();
                }
                if candidate.next() == Some('m')
                    && (has_parameters
                        || !candidate
                            .peek()
                            .is_some_and(|c| c.is_alphanumeric() || *c == ']'))
                {
                    chars = candidate;
                } else {
                    out.push(ch);
                }
            }
            '\n' | '\t' => out.push(ch),
            _ if ch.is_control() => {}
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::notification_text;

    #[test]
    fn strips_terminal_styles_and_screenshot_fragments() {
        for codes in [
            "\x1b[2m\x1b[0m\x1b[38;2;99;168;248mReady\x1b[39m",
            "[2m[0m[1m[0m[2m[0m[38;2;99;168;248m[39mReady[39m",
            "[48;2;72;76;92m[1m[0m[38;5;248mReady[m",
            "\u{9b}38:2::99:168:248mReady\u{9b}0m",
        ] {
            assert_eq!(notification_text(codes), "Ready");
        }
    }

    #[test]
    fn removes_terminal_commands_and_keeps_link_text() {
        assert_eq!(
            notification_text("\x1b]0;title\x07\x1b[2J\x1b[?25l\x1b]8;;https://example.com\x1b\\Review\x1b]8;;\x1b\\\r\nnow\tplease"),
            "Review\nnow\tplease"
        );
    }

    #[test]
    fn preserves_brackets_unicode_and_plain_text() {
        let text = "Review [1] and [1, 2], [main], [38;2] and [2 minutes].\nภาษาไทย";
        assert_eq!(notification_text(text), text);
        assert_eq!(notification_text("Ready\x1b[38;2;"), "Ready");
    }
}
