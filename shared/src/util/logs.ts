// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b\[[0-9;]*m/g;

const SEPARATOR_RE = /^[\s\-_=~\u2501\u2500\u2550\u254C\u254D\u2504\u2505\u2508\u2509\u2574\u2576\u2578\u257A\u2594\u2581|│┃┆┇┊┋╎╏]+$/;

/**
 * Collapse consecutive separator lines (lines composed entirely of -_=~ and
 * box-drawing characters) down to a single occurrence. This prevents 5+
 * identical separator lines from wasting vertical space on mobile.
 */
export function collapseSeparators(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prevWasSep = false;

  for (const line of lines) {
    const stripped = line.replace(ANSI_STRIP, "").trim();
    const isSep = stripped.length > 0 && SEPARATOR_RE.test(stripped);
    if (isSep && prevWasSep) continue;
    out.push(line);
    prevWasSep = isSep;
  }

  return out.join("\n");
}
