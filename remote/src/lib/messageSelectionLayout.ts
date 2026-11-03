type SelectionLine = { text: string; y: number; height: number };

export function messageSelectionLayout(text: string, offset: number, lines: readonly SelectionLine[]) {
  let cursor = 0;
  let selected = lines.at(-1);
  for (const line of lines) {
    const start = Math.max(cursor, text.indexOf(line.text, cursor));
    const end = start + line.text.length;
    if (offset < end || offset === start) { selected = line; break; }
    cursor = end;
  }
  const last = lines.at(-1);
  return { height: Math.ceil((last ? last.y + last.height : 18) + 24),
    selectedY: (selected?.y ?? 0) + 12, selectedHeight: selected?.height ?? 18 };
}
