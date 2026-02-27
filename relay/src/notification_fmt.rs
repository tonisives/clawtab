use clawtab_protocol::QuestionOption;

/// Format the notification body for an iOS push notification.
/// iOS shows ~5 lines of text. Strategy:
/// - Lines 1-2: question context (the actual question being asked)
/// - Lines 3-5: answer options
///
/// `context_lines` is raw terminal output that includes the question text,
/// numbered options, option descriptions, and decorative lines. We need to
/// extract just the question and format options from the structured data.
pub fn format_body(context_lines: &str, options: &[QuestionOption]) -> String {
    // Build set of option number prefixes so we can identify option lines
    // and their description lines in the raw terminal output.
    let option_prefixes: Vec<String> = options.iter().map(|o| format!("{}.", o.number)).collect();

    // Find where options start in the terminal output, keep only lines before that
    let lines: Vec<&str> = context_lines.lines().collect();
    let first_option_idx = lines.iter().position(|l| {
        let stripped = l
            .trim()
            .trim_start_matches(|c: char| matches!(c, '>' | '~' | '`' | '|' | ' ') || !c.is_ascii())
            .trim();
        option_prefixes.iter().any(|p| stripped.starts_with(p))
    });

    // Everything before the first option line is potential question context
    let pre_option_lines: Vec<&str> = match first_option_idx {
        Some(idx) => lines[..idx].to_vec(),
        None => lines.clone(),
    };

    // Filter out decorative/empty lines from the question context
    let question_text: Vec<&str> = pre_option_lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            if t.is_empty() {
                return false;
            }
            // Skip lines made entirely of box-drawing / decoration chars
            !t.chars().all(|c| {
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
        })
        .copied()
        .collect();

    // Format options compactly.
    // If all labels are short (<= 10 chars), put on single line: "1.Paris 2.Lyon 3.Marseille"
    // Otherwise one per line: "1. Fix the authentication bug\n2. Skip this step"
    let options_str = if options.is_empty() {
        String::new()
    } else {
        let all_short = options.iter().all(|o| o.label.len() <= 10);
        if all_short {
            options
                .iter()
                .map(|o| format!("{}.{}", o.number, o.label))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            options
                .iter()
                .map(|o| format!("{}. {}", o.number, o.label))
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    // Take at most 2 lines of question context (last lines are most relevant)
    if question_text.is_empty() {
        options_str
    } else {
        let ctx = question_text
            .iter()
            .rev()
            .take(2)
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        if options_str.is_empty() {
            ctx
        } else {
            format!("{ctx}\n{options_str}")
        }
    }
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
            // Skip the username, treat everything after as the meaningful path
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

    // Keep last 2 segments full, abbreviate the rest
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
    fn test_france_question_short_options() {
        // Real terminal output from Claude asking about capital of France
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
        // Should show the question and compact options
        assert!(body.contains("What is the capital of France?"), "body: {body}");
        // All labels <= 10 chars, so should be on single line
        // But "Type something." is 15 chars, so it goes multi-line
        // Actually "Chat about this" is 15 chars too
        assert!(!body.contains("The City of Light"), "descriptions should be filtered: {body}");
        assert!(!body.contains("Second-largest"), "descriptions should be filtered: {body}");
        println!("France question body:\n{body}");
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
        // Yes/No are short, should be on single line
        assert!(body.contains("1.Yes 2.No"), "short options should be inline: {body}");
        println!("Yes/No body:\n{body}");
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
        // "Allow always" is 12 chars (> 10), so multi-line
        assert!(body.contains("1. Allow once"), "body: {body}");
        assert!(body.contains("3. Deny"), "body: {body}");
        println!("Tool permission body:\n{body}");
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
        // Long options, each on own line
        assert!(body.contains("1. Refactor"), "body: {body}");
        assert!(body.contains("\n2. Keep"), "body: {body}");
        println!("Long options body:\n{body}");
    }

    #[test]
    fn test_no_context_only_options() {
        let context = "\
\u{203A} 1. Fix the bug
  2. Skip";

        let options = vec![opt("1", "Fix the bug"), opt("2", "Skip")];

        let body = format_body(context, &options);
        // No question context, just options. "Fix the bug" is 11 chars (> 10), multi-line
        assert!(body.contains("1. Fix the bug"), "body: {body}");
        assert!(body.contains("2. Skip"), "body: {body}");
        println!("No context body:\n{body}");
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
        // Ensure description lines under options don't leak into notification
        let context = "\
What is the capital of France?

\u{203A} 1. Paris
   The City of Light, located in northern France
  2. Lyon
   Second-largest city, known for cuisine";

        let options = vec![opt("1", "Paris"), opt("2", "Lyon")];

        let body = format_body(context, &options);
        assert!(!body.contains("City of Light"), "descriptions filtered: {body}");
        assert!(!body.contains("Second-largest"), "descriptions filtered: {body}");
        assert!(body.contains("capital of France"), "question present: {body}");
        assert!(body.contains("1.Paris 2.Lyon"), "options present: {body}");
        println!("Filtered descriptions body:\n{body}");
    }

    #[test]
    fn test_decorative_lines_filtered() {
        let context = "\
---
Geography
===
What is the capital of France?

\u{203A} 1. Paris
  2. Lyon";

        let options = vec![opt("1", "Paris"), opt("2", "Lyon")];

        let body = format_body(context, &options);
        assert!(!body.contains("---"), "decorative filtered: {body}");
        assert!(!body.contains("==="), "decorative filtered: {body}");
        println!("Decorative lines body:\n{body}");
    }
}
