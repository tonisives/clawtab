// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b\[[0-9;]*[A-Za-z]/g;

const SEPARATOR_RE = /^[\s\-_=~\u2501\u2500\u2550\u254C\u254D\u2504\u2505\u2508\u2509\u2574\u2576\u2578\u257A\u2594\u2581|│┃┆┇┊┋╎╏]+$/;

function isSeparator(line: string): boolean {
  const stripped = line.replace(ANSI_STRIP, "").trim();
  return stripped.length > 0 && SEPARATOR_RE.test(stripped);
}

function isBlank(line: string): boolean {
  return line.replace(ANSI_STRIP, "").trim().length === 0;
}

/** Trim a separator line to at most `max` visible characters. */
function truncateSeparator(line: string, max: number): string {
  const stripped = line.replace(ANSI_STRIP, "");
  if (stripped.length <= max) return line;
  // For plain separator lines (no ANSI), just slice
  if (stripped.length === line.length) return line.slice(0, max);
  // With ANSI codes, walk through keeping codes but counting visible chars
  let vis = 0;
  let i = 0;
  while (i < line.length && vis < max) {
    const m = line.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
    if (m) { i += m[0].length; continue; }
    vis++;
    i++;
  }
  return line.slice(0, i);
}

const DEFAULT_MAX_SEP = 40;

/**
 * Collapse consecutive separator lines down to a single occurrence,
 * collapse runs of blank lines to one, and remove blank lines
 * adjacent to separators. Separator lines are truncated to `maxSepLen`
 * visible characters so they don't wrap in narrow views.
 */
export function collapseSeparators(text: string, maxSepLen = DEFAULT_MAX_SEP): string {
  const lines = text.replace(/\r/g, "").split("\n");

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

    // Truncate separator lines to avoid wrapping in narrow views
    out.push(sep ? truncateSeparator(lines[i], maxSepLen) : lines[i]);
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
