import { Text, type TextStyle } from "react-native";
import { useMemo } from "react";

// Basic ANSI color map (foreground 30-37)
const BASE_COLORS: Record<number, string> = {
  30: "#4a4a4a", // black (slightly visible on dark bg)
  31: "#ff6b6b", // red
  32: "#69db7c", // green
  33: "#ffd43b", // yellow
  34: "#74c0fc", // blue
  35: "#da77f2", // magenta
  36: "#66d9e8", // cyan
  37: "#dee2e6", // white
};

// Bright variants (90-97)
const BRIGHT_COLORS: Record<number, string> = {
  90: "#868e96", // bright black
  91: "#ff8787", // bright red
  92: "#8ce99a", // bright green
  93: "#ffe066", // bright yellow
  94: "#a5d8ff", // bright blue
  95: "#e599f7", // bright magenta
  96: "#99e9f2", // bright cyan
  97: "#f8f9fa", // bright white
};

// 256-color palette (codes 0-15 only; 16-255 approximated)
const COLOR_256: string[] = [
  "#4a4a4a", "#ff6b6b", "#69db7c", "#ffd43b", "#74c0fc", "#da77f2", "#66d9e8", "#dee2e6",
  "#868e96", "#ff8787", "#8ce99a", "#ffe066", "#a5d8ff", "#e599f7", "#99e9f2", "#f8f9fa",
];

function color256(n: number): string | undefined {
  if (n < 16) return COLOR_256[n];
  if (n < 232) {
    // 6x6x6 cube
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${toHex(r)},${toHex(g)},${toHex(b)})`;
  }
  // Grayscale 232-255
  const level = 8 + (n - 232) * 10;
  return `rgb(${level},${level},${level})`;
}

interface Span {
  text: string;
  style: TextStyle;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

function parseAnsi(raw: string): Span[] {
  const spans: Span[] = [];
  let lastIndex = 0;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let fg: string | undefined;

  for (const match of raw.matchAll(ANSI_RE)) {
    // Push text before this escape
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index);
      if (text) {
        const style: TextStyle = {};
        if (fg) style.color = fg;
        if (bold) style.fontWeight = "bold";
        if (dim) style.opacity = 0.6;
        if (italic) style.fontStyle = "italic";
        if (underline) style.textDecorationLine = "underline";
        spans.push({ text, style });
      }
    }
    lastIndex = match.index + match[0].length;

    // Parse SGR codes
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        bold = false;
        dim = false;
        italic = false;
        underline = false;
        fg = undefined;
      } else if (c === 1) {
        bold = true;
      } else if (c === 2) {
        dim = true;
      } else if (c === 3) {
        italic = true;
      } else if (c === 4) {
        underline = true;
      } else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c === 23) {
        italic = false;
      } else if (c === 24) {
        underline = false;
      } else if (c >= 30 && c <= 37) {
        fg = BASE_COLORS[c];
      } else if (c === 39) {
        fg = undefined;
      } else if (c >= 90 && c <= 97) {
        fg = BRIGHT_COLORS[c];
      } else if (c === 38) {
        // Extended color: 38;5;N or 38;2;R;G;B
        if (codes[i + 1] === 5 && i + 2 < codes.length) {
          fg = color256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
          fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
      }
    }
  }

  // Remaining text after last escape
  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex);
    if (text) {
      const style: TextStyle = {};
      if (fg) style.color = fg;
      if (bold) style.fontWeight = "bold";
      if (dim) style.opacity = 0.6;
      if (italic) style.fontStyle = "italic";
      if (underline) style.textDecorationLine = "underline";
      spans.push({ text, style });
    }
  }

  return spans;
}

/** Returns true if the string contains ANSI escape codes */
export function hasAnsi(s: string): boolean {
  return s.includes("\x1b[");
}

export function AnsiText({
  content,
  style,
  selectable,
}: {
  content: string;
  style?: TextStyle;
  selectable?: boolean;
}) {
  const spans = useMemo(() => parseAnsi(content), [content]);

  if (spans.length === 0) {
    return null;
  }

  // Fast path: single unstyled span
  if (spans.length === 1 && Object.keys(spans[0].style).length === 0) {
    return (
      <Text style={style} selectable={selectable}>
        {spans[0].text}
      </Text>
    );
  }

  return (
    <Text style={style} selectable={selectable}>
      {spans.map((span, i) => (
        <Text key={i} style={span.style}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
}
