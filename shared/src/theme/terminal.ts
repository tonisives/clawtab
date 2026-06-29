import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalTheme = NonNullable<ITerminalOptions["theme"]>;

export const TERMINAL_FONT_SIZE = 12;
export const TERMINAL_LINE_HEIGHT = 1.25;

export const TERMINAL_FONT_FAMILY = [
  '"MesloLGS Nerd Font Mono"',
  '"MesloLGM Nerd Font Mono"',
  '"MesloLGL Nerd Font Mono"',
  '"MesloLGSDZ Nerd Font Mono"',
  '"MesloLGMDZ Nerd Font Mono"',
  '"MesloLGLDZ Nerd Font Mono"',
  '"MesloLGS NF"',
  '"MesloLGM Nerd Font"',
  '"JetBrainsMono Nerd Font"',
  '"Hack Nerd Font"',
  '"FiraCode Nerd Font"',
  '"CaskaydiaCove Nerd Font"',
  '"Symbols Nerd Font Mono"',
  '"SF Mono"',
  "Menlo",
  "Monaco",
  "Consolas",
  '"Liberation Mono"',
  '"DejaVu Sans Mono"',
  '"Apple Symbols"',
  "monospace",
].join(", ");

export const DARK_TERMINAL_THEME: TerminalTheme = {
  background: "#1c1c1e",
  foreground: "#e4e4e4",
  cursor: "#7986cb",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(121, 134, 203, 0.3)",
  selectionForeground: "#e4e4e4",
  black: "#161616",
  red: "#ff453a",
  green: "#32d74b",
  yellow: "#ff9f0a",
  blue: "#7986cb",
  magenta: "#da77f2",
  cyan: "#66d9e8",
  white: "#e4e4e4",
  brightBlack: "#555",
  brightRed: "#ff6b6b",
  brightGreen: "#51cf66",
  brightYellow: "#ffd43b",
  brightBlue: "#91d5ff",
  brightMagenta: "#e599f7",
  brightCyan: "#99e9f2",
  brightWhite: "#ffffff",
};

export const LIGHT_TERMINAL_THEME: TerminalTheme = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#5c6bc0",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(92, 107, 192, 0.22)",
  selectionForeground: "#1d1d1f",
  black: "#1d1d1f",
  red: "#e5484d",
  green: "#30a46c",
  yellow: "#c4841d",
  blue: "#5c6bc0",
  magenta: "#ab4aba",
  cyan: "#12a3b4",
  white: "#f5f5f7",
  brightBlack: "#8e8e93",
  brightRed: "#ff6b6b",
  brightGreen: "#51cf66",
  brightYellow: "#d99a2b",
  brightBlue: "#748ffc",
  brightMagenta: "#d084df",
  brightCyan: "#3bc9db",
  brightWhite: "#ffffff",
};

export function getTerminalTheme(): TerminalTheme {
  if (typeof window === "undefined") return DARK_TERMINAL_THEME;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? DARK_TERMINAL_THEME
    : LIGHT_TERMINAL_THEME;
}

export function subscribeTerminalThemeChange(onChange: (theme: TerminalTheme) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange(getTerminalTheme());
  query.addEventListener?.("change", handler);
  return () => query.removeEventListener?.("change", handler);
}
