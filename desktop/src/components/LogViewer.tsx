import { useEffect, useMemo, useRef } from "react";
import { collapseSeparators } from "@clawtab/shared/src/util/logs";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

const BASE: Record<number, string> = {
  30: "#4a4a4a", 31: "#ff6b6b", 32: "#69db7c", 33: "#ffd43b",
  34: "#74c0fc", 35: "#da77f2", 36: "#66d9e8", 37: "#dee2e6",
};
const BRIGHT: Record<number, string> = {
  90: "#868e96", 91: "#ff8787", 92: "#8ce99a", 93: "#ffe066",
  94: "#a5d8ff", 95: "#e599f7", 96: "#99e9f2", 97: "#f8f9fa",
};
const C256: string[] = [
  "#4a4a4a", "#ff6b6b", "#69db7c", "#ffd43b", "#74c0fc", "#da77f2", "#66d9e8", "#dee2e6",
  "#868e96", "#ff8787", "#8ce99a", "#ffe066", "#a5d8ff", "#e599f7", "#99e9f2", "#f8f9fa",
];

function c256(n: number): string {
  if (n < 16) return C256[n];
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36), g = Math.floor((idx % 36) / 6), b = idx % 6;
    const h = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${h(r)},${h(g)},${h(b)})`;
  }
  const l = 8 + (n - 232) * 10;
  return `rgb(${l},${l},${l})`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(raw: string): string {
  let out = "";
  let lastIdx = 0;
  let bold = false, dim = false, italic = false, underline = false;
  let fg: string | undefined;
  let open = false;

  for (const m of raw.matchAll(ANSI_RE)) {
    if (m.index > lastIdx) {
      const text = esc(raw.slice(lastIdx, m.index));
      if (!open && (fg || bold || dim || italic || underline)) {
        const parts: string[] = [];
        if (fg) parts.push(`color:${fg}`);
        if (bold) parts.push("font-weight:bold");
        if (dim) parts.push("opacity:0.6");
        if (italic) parts.push("font-style:italic");
        if (underline) parts.push("text-decoration:underline");
        out += `<span style="${parts.join(";")}">${text}`;
        open = true;
      } else if (open) {
        out += text;
      } else {
        out += text;
      }
    }
    lastIdx = m.index + m[0].length;

    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    // Close any open span before changing style
    if (open) { out += "</span>"; open = false; }

    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { bold = false; dim = false; italic = false; underline = false; fg = undefined; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = BASE[c];
      else if (c === 39) fg = undefined;
      else if (c >= 90 && c <= 97) fg = BRIGHT[c];
      else if (c === 38) {
        if (codes[i + 1] === 5 && i + 2 < codes.length) { fg = c256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2 && i + 4 < codes.length) { fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
    }
  }

  if (lastIdx < raw.length) {
    const text = esc(raw.slice(lastIdx));
    if (open) { out += text + "</span>"; }
    else if (fg || bold || dim || italic || underline) {
      const parts: string[] = [];
      if (fg) parts.push(`color:${fg}`);
      if (bold) parts.push("font-weight:bold");
      if (dim) parts.push("opacity:0.6");
      if (italic) parts.push("font-style:italic");
      if (underline) parts.push("text-decoration:underline");
      out += `<span style="${parts.join(";")}">${text}</span>`;
    } else {
      out += text;
    }
  } else if (open) {
    out += "</span>";
  }

  return out;
}

interface Props {
  content: string;
  autoScroll?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function LogViewer({ content, autoScroll = true, className, style }: Props) {
  const ref = useRef<HTMLPreElement>(null);

  const processed = useMemo(() => collapseSeparators(content), [content]);
  const hasAnsi = processed.includes("\x1b[");
  const html = useMemo(() => hasAnsi ? ansiToHtml(processed) : null, [processed, hasAnsi]);

  useEffect(() => {
    if (autoScroll && ref.current) {
      const el = ref.current;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [processed, autoScroll]);

  const cls = className ?? "log-viewer";

  if (html) {
    return <pre ref={ref} className={cls} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <pre ref={ref} className={cls} style={style}>{processed}</pre>;
}
