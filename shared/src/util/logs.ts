// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b\[[0-9;]*m/g;

const SEPARATOR_RE = /^[\s\-_=~\u2501\u2500\u2550\u254C\u254D\u2504\u2505\u2508\u2509\u2574\u2576\u2578\u257A\u2594\u2581|│┃┆┇┊┋╎╏]+$/;

function isSeparator(line: string): boolean {
  const stripped = line.replace(ANSI_STRIP, "").trim();
  return stripped.length > 0 && SEPARATOR_RE.test(stripped);
}

function isBlank(line: string): boolean {
  return line.replace(ANSI_STRIP, "").trim().length === 0;
}

/**
 * Collapse consecutive separator lines down to a single occurrence,
 * collapse runs of blank lines to one, and remove blank lines
 * adjacent to separators.
 */
export function collapseSeparators(text: string): string {
  const lines = text.split("\n");

  // First pass: mark separator lines
  const seps = lines.map(isSeparator);
  const blanks = lines.map(isBlank);

  const out: string[] = [];
  let prevWasSep = false;
  let prevWasBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const sep = seps[i];
    const blank = blanks[i];

    // Skip extra separators after a separator
    if (prevWasSep && (sep || blank)) continue;
    // Skip consecutive blanks
    if (blank && prevWasBlank) continue;
    // Skip blank lines immediately before a separator (look ahead)
    if (blank) {
      let next = i + 1;
      while (next < lines.length && blanks[next]) next++;
      if (next < lines.length && seps[next]) continue;
    }

    out.push(lines[i]);
    prevWasSep = sep;
    prevWasBlank = blank;
  }

  return out.join("\n");
}

/**
 * Remove all separator lines entirely. Useful for compact previews
 * like notification cards where separators waste space.
 */
export function stripSeparators(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isSeparator(line))
    .join("\n");
}
