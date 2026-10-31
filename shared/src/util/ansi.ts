import type { TextStyle } from "react-native";

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
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
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

export interface AnsiSpan {
  text: string;
  style: TextStyle;
}

// CSI, OSC (including hyperlinks), and other terminal escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-?]*[ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[@-~]/g;

export function normalizeTerminalNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function stripAnsi(text: string): string {
  return normalizeTerminalNewlines(text).replace(ANSI_RE, "");
}

// ANSI colors above use hex or rgb(). Compare their brightness before removing
// a fill so dark text selected against a light terminal background stays legible.
function brightness(color: string): number {
  const rgb = color.startsWith("#")
    ? color.slice(1).match(/../g)?.map((part) => parseInt(part, 16))
    : color.match(/[\d.]+/g)?.map(Number);
  if (!rgb || rgb.length < 3) return 255;
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
}

export function parseAnsi(
  raw: string,
  foreground = "#dee2e6",
  background = "#000000",
  showBackgrounds = true,
): AnsiSpan[] {
  const text = normalizeTerminalNewlines(raw);
  const spans: AnsiSpan[] = [];
  let lastIndex = 0;
  let bold = false, dim = false, italic = false, underline = false, inverse = false;
  let fg: string | undefined, bg: string | undefined;

  const push = (value: string) => {
    if (!value) return;
    const style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
    if (fg) style.color = fg;
    if (bg) style.backgroundColor = bg;
    if (inverse) {
      style.color = bg ?? background;
      style.backgroundColor = fg ?? foreground;
    }
    if (!showBackgrounds && style.backgroundColor) {
      const textColor = (style.color ?? foreground) as string;
      const fillColor = style.backgroundColor as string;
      if (Math.abs(brightness(textColor) - brightness(background)) < 80) {
        style.color = Math.abs(brightness(fillColor) - brightness(background)) >= 80
          ? fillColor
          : foreground;
      }
      delete style.backgroundColor;
    }
    if (bold) style.fontWeight = "bold";
    if (dim) style.opacity = 0.6;
    if (italic) style.fontStyle = "italic";
    if (underline) style.textDecorationLine = "underline";
    spans.push({ text: value, style });
  };

  for (const match of text.matchAll(ANSI_RE)) {
    push(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    if (match[2] !== "m") continue;

    const params = (match[1] || "0").split(";");
    for (let i = 0; i < params.length; i++) {
      const parts = params[i].split(":").map(Number);
      const code = parts[0];
      if (code === 0) {
        bold = dim = italic = underline = inverse = false;
        fg = bg = undefined;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 7) inverse = true;
      else if (code === 22) bold = dim = false;
      else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 27) inverse = false;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if (code >= 30 && code <= 37) fg = BASE_COLORS[code];
      else if (code >= 90 && code <= 97) fg = BRIGHT_COLORS[code];
      else if (code >= 40 && code <= 47) bg = BASE_COLORS[code - 10];
      else if (code >= 100 && code <= 107) bg = BRIGHT_COLORS[code - 10];
      else if (code === 38 || code === 48) {
        const colon = parts.length > 1;
        const mode = colon ? parts[1] : Number(params[i + 1]);
        let color: string | undefined;
        if (mode === 5) {
          color = color256(colon ? parts[2] : Number(params[i + 2]));
          if (!colon) i += 2;
        } else if (mode === 2) {
          // Colon RGB may include an empty or zero color-space identifier.
          const rgb = colon ? parts.slice(parts.length >= 6 ? 3 : 2) : params.slice(i + 2, i + 5).map(Number);
          if (rgb.length === 3 && rgb.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
            color = `rgb(${rgb.join(",")})`;
          }
          if (!colon) i += 4;
        }
        if (color) {
          if (code === 38) fg = color;
          else bg = color;
        }
      }
    }
  }
  push(text.slice(lastIndex));
  return spans;
}

