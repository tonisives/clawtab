use clawtab_protocol::QuestionOption;

/// Strip ANSI escape sequences from text.
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Format the notification body for an iOS push notification.
/// iOS shows ~5 lines of text on the lock screen. Strategy:
/// - Options get priority (they're actionable)
/// - Question context gets 1 line max, truncated if needed
/// - Filter out terminal artifacts (breadcrumbs, navigation, decorative lines)
///
/// `context_lines` is raw terminal output that includes the question text,
/// numbered options, option descriptions, and decorative/UI lines.
pub fn format_body(context_lines: &str, options: &[QuestionOption]) -> String {
    let context_lines = strip_ansi(context_lines);
    let option_prefixes: Vec<String> = options.iter().map(|o| format!("{}.", o.number)).collect();

    // Find where options start in the terminal output, keep only lines before that
    let lines: Vec<&str> = context_lines.lines().collect();
    let first_option_idx = lines.iter().position(|l| {
        let stripped = strip_prompt_chars(l.trim());
        option_prefixes.iter().any(|p| stripped.starts_with(p))
    });

    // Everything before the first option line is potential question context
    let pre_option_lines = match first_option_idx {
        Some(idx) => &lines[..idx],
        None => &lines[..],
    };

    // Filter out decorative/empty/artifact lines from the question context
    let question_text: Vec<&str> = pre_option_lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            if t.is_empty() {
                return false;
            }
            if is_decorative_line(t) {
                return false;
            }
            if is_ui_artifact(t) {
                return false;
            }
            true
        })
        .copied()
        .collect();

    // Format options: only labels, no descriptions
    let options_str = format_options(options);

    // Take only the last line of question context (most relevant = the actual question)
    // and truncate to ~80 chars so it fits in 1 line on iOS
    if question_text.is_empty() {
        options_str
    } else {
        let last_line = question_text.last().unwrap().trim();
        let ctx = truncate(last_line, 80);
        if options_str.is_empty() {
            ctx
        } else {
            format!("{ctx}\n{options_str}")
        }
    }
}

/// Format options compactly.
/// If all options fit on a single line (<= 45 chars total), use "1.Yes 2.No 3.Skip"
/// Otherwise one per line: "1. Fix the auth bug\n2. Skip"
fn format_options(options: &[QuestionOption]) -> String {
    if options.is_empty() {
        return String::new();
    }

    // Try single-line format first
    let single_line: String = options
        .iter()
        .map(|o| format!("{}.{}", o.number, o.label))
        .collect::<Vec<_>>()
        .join(" ");

    if single_line.len() <= 45 {
        single_line
    } else {
        options
            .iter()
            .map(|o| format!("{}. {}", o.number, o.label))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max - 1;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

fn strip_prompt_chars(s: &str) -> &str {
    s.trim_start_matches(|c: char| matches!(c, '>' | '~' | '`' | '|' | ' ') || !c.is_ascii())
        .trim()
}

/// Lines made entirely of box-drawing / decoration chars
fn is_decorative_line(t: &str) -> bool {
    t.chars().all(|c| {
        matches!(
            c,
            '-' | '_'
                | '='
                | '~'
                | '\u{2501}'
                | '\u{2500}'
                | '\u{2550}'
                | '\u{254C}'
                | '\u{254D}'
                | '\u{2504}'
                | '\u{2505}'
                | '\u{2508}'
                | '\u{2509}'
                | '\u{2574}'
                | '\u{2576}'
                | '\u{2578}'
                | '\u{257A}'
                | '\u{2594}'
                | '\u{2581}'
                | '|'
                | '\u{2502}'
                | '\u{2503}'
                | ' '
        )
    })
}

/// Terminal UI artifacts: breadcrumbs, navigation hints, status lines, progress indicators
fn is_ui_artifact(t: &str) -> bool {
    // Breadcrumb/navigation lines with arrows and checkbox chars
    // e.g. "<- SSR goal  Architecture  Hydration  Submit ->"
    if (t.contains('\u{2190}') || t.contains('\u{2192}') || t.contains("<-") || t.contains("->"))
        && (t.contains('\u{25A1}') // empty checkbox
            || t.contains('\u{25A0}') // filled checkbox
            || t.contains('\u{2713}') // checkmark
            || t.contains('\u{2714}') // heavy checkmark
            || t.contains("Submit"))
    {
        return true;
    }
    // Lines that are navigation hints
    if t.contains("Enter to select")
        || t.contains("to navigate")
        || t.contains("Esc to cancel")
        || t.contains("ctrl+o to expand")
        || t.contains("shift+tab")
        || t.contains("accept edits")
    {
        return true;
    }
    // Lines that are purely checkbox/breadcrumb items without question marks
    let checkbox_count = t.matches('\u{25A1}').count() + t.matches('\u{25A0}').count();
    if checkbox_count >= 2 && !t.contains('?') {
        return true;
    }
    // Progress/status indicator lines (e.g. "Read 5 files (ctrl+o to expand)")
    if t.starts_with("Read ") && t.contains("files") {
        return true;
    }
    false
}

/// Compact a cwd path for use as a notification title.
/// Keeps the last 2 segments in full, abbreviates earlier ones to first char.
/// e.g. "/Users/tonis/workspace/tgs/clawtab/public" -> "~/w/t/clawtab/public"
///      "/home/user/myproject" -> "~/myproject"
pub fn compact_cwd(cwd: &str) -> String {
    let path = cwd
        .strip_prefix("/Users/")
        .or_else(|| cwd.strip_prefix("/home/"));
    let segments: Vec<&str> = match path {
        Some(rest) => {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if parts.len() < 2 {
                return cwd.rsplit('/').next().unwrap_or(cwd).to_string();
            }
            parts[1].split('/').filter(|s| !s.is_empty()).collect()
        }
        None => cwd.split('/').filter(|s| !s.is_empty()).collect(),
    };

    if segments.is_empty() {
        return cwd.to_string();
    }

    let keep_full = 2.min(segments.len());
    let abbrev_count = segments.len() - keep_full;

    let mut parts: Vec<String> = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        if i < abbrev_count {
            parts.push(seg.chars().next().map(|c| c.to_string()).unwrap_or_default());
        } else {
            parts.push(seg.to_string());
        }
    }

    let joined = parts.join("/");
    if path.is_some() {
        format!("~/{joined}")
    } else {
        format!("/{joined}")
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn opt(number: &str, label: &str) -> QuestionOption {
        QuestionOption {
            number: number.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn test_france_question() {
        let context = "\
Geography

What is the capital of France?

\u{203A} 1. Paris
   The City of Light, located in northern France
  2. Lyon
   Second-largest city, known for cuisine
  3. Marseille
   Port city on the Mediterranean coast
  4. Bordeaux
   Wine region capital in southwestern France
  5. Type something.
  6. Chat about this";

        let options = vec![
            opt("1", "Paris"),
            opt("2", "Lyon"),
            opt("3", "Marseille"),
            opt("4", "Bordeaux"),
            opt("5", "Type something."),
            opt("6", "Chat about this"),
        ];

        let body = format_body(context, &options);
        assert!(body.contains("capital of France"), "question present: {body}");
        assert!(!body.contains("City of Light"), "descriptions filtered: {body}");
        assert!(!body.contains("Geography"), "only last line of context: {body}");
        println!("France:\n{body}\n");
    }

    #[test]
    fn test_ssr_question_with_breadcrumbs() {
        // Real terminal output with breadcrumb artifacts
        let context = "\
Read 5 files (ctrl+o to expand)

Now I have a very thorough understanding. Before writing the plan, I have a few questions to clarify scope.

\u{2190} \u{25A1} SSR goal  \u{25A1} Architecture  \u{25A1} Hydration  \u{2714} Submit  \u{2192}

What's the primary goal for moving to SSR? Is it SEO (replacing the prerender service), faster initial page loads, or both?

\u{203A} 1. SEO (replace prerender)
   Eliminate the prerender service dependency, serve fully-rendered HTML to crawlers natively
  2. Both SEO + performance
   Better SEO and faster initial paint for users
  3. Full SSR for all pages
   Every page server-rendered, SPA behavior only for client interactions
  4. Type something.
  5. Chat about this
  6. Skip interview and plan immediately";

        let options = vec![
            opt("1", "SEO (replace prerender)"),
            opt("2", "Both SEO + performance"),
            opt("3", "Full SSR for all pages"),
            opt("4", "Type something."),
            opt("5", "Chat about this"),
            opt("6", "Skip interview and plan immediately"),
        ];

        let body = format_body(context, &options);
        // Should NOT contain breadcrumb/navigation artifacts
        assert!(!body.contains("SSR goal"), "breadcrumbs filtered: {body}");
        assert!(!body.contains("Architecture"), "breadcrumbs filtered: {body}");
        assert!(!body.contains("Read 5 files"), "progress filtered: {body}");
        assert!(!body.contains("thorough understanding"), "only last context line: {body}");
        // Should contain the question (truncated to ~80 chars)
        assert!(body.contains("primary goal"), "question present: {body}");
        // Should contain the options
        assert!(body.contains("1. SEO"), "options present: {body}");
        println!("SSR:\n{body}\n");
    }

    #[test]
    fn test_yes_no_question() {
        let context = "\
Do you want to proceed with the changes?

\u{203A} 1. Yes
  2. No";

        let options = vec![opt("1", "Yes"), opt("2", "No")];

        let body = format_body(context, &options);
        assert!(body.contains("proceed with the changes"), "body: {body}");
        assert!(body.contains("1.Yes 2.No"), "short options inline: {body}");
        println!("Yes/No:\n{body}\n");
    }

    #[test]
    fn test_tool_permission_question() {
        let context = "\
Claude wants to run the following command:

  rm -rf /tmp/build-cache

Allow this action?

\u{203A} 1. Allow once
  2. Allow always
  3. Deny";

        let options = vec![
            opt("1", "Allow once"),
            opt("2", "Allow always"),
            opt("3", "Deny"),
        ];

        let body = format_body(context, &options);
        assert!(body.contains("Allow this action?"), "body: {body}");
        println!("Tool permission:\n{body}\n");
    }

    #[test]
    fn test_long_options() {
        let context = "\
Which approach should we use?

\u{203A} 1. Refactor the authentication module to use JWT tokens
  2. Keep the current session-based auth and add rate limiting
  3. Switch to OAuth2 with Google provider";

        let options = vec![
            opt("1", "Refactor the authentication module to use JWT tokens"),
            opt("2", "Keep the current session-based auth and add rate limiting"),
            opt("3", "Switch to OAuth2 with Google provider"),
        ];

        let body = format_body(context, &options);
        assert!(body.contains("Which approach"), "body: {body}");
        assert!(body.contains("1. Refactor"), "body: {body}");
        println!("Long options:\n{body}\n");
    }

    #[test]
    fn test_no_context_only_options() {
        let context = "\
\u{203A} 1. Fix the bug
  2. Skip";

        let options = vec![opt("1", "Fix the bug"), opt("2", "Skip")];

        let body = format_body(context, &options);
        // "1.Fix the bug 2.Skip" = 21 chars, fits single line
        assert!(body.contains("1.Fix the bug 2.Skip"), "body: {body}");
        println!("No context:\n{body}\n");
    }

    #[test]
    fn test_compact_cwd() {
        assert_eq!(
            compact_cwd("/Users/tonis/workspace/tgs/clawtab/public"),
            "~/w/t/clawtab/public"
        );
        assert_eq!(compact_cwd("/home/user/myproject"), "~/myproject");
        assert_eq!(compact_cwd("/Users/tonis/dev"), "~/dev");
        assert_eq!(
            compact_cwd("/Users/tonis/workspace/tgs/clawtab/public/relay"),
            "~/w/t/c/public/relay"
        );
    }

    #[test]
    fn test_description_lines_filtered() {
        let context = "\
What is the capital of France?

\u{203A} 1. Paris
   The City of Light, located in northern France
  2. Lyon
   Second-largest city, known for cuisine";

        let options = vec![opt("1", "Paris"), opt("2", "Lyon")];

        let body = format_body(context, &options);
        assert!(!body.contains("City of Light"), "descriptions filtered: {body}");
        assert!(body.contains("capital of France"), "question present: {body}");
        assert!(body.contains("1.Paris 2.Lyon"), "options present: {body}");
        println!("Filtered descriptions:\n{body}\n");
    }

    #[test]
    fn test_truncate_long_question() {
        let context = "\
What's the primary goal for moving to SSR? Is it SEO (replacing the prerender service), faster initial page loads, or both?

\u{203A} 1. SEO
  2. Both";

        let options = vec![opt("1", "SEO"), opt("2", "Both")];

        let body = format_body(context, &options);
        // Question should be truncated to ~80 chars
        let first_line = body.lines().next().unwrap();
        assert!(first_line.len() <= 83, "truncated to ~80: len={} {first_line}", first_line.len());
        assert!(first_line.ends_with("..."), "ends with ellipsis: {first_line}");
        println!("Truncated:\n{body}\n");
    }
}
