import type { ITerminalOptions } from "@xterm/xterm";
import type { Terminal } from "@xterm/xterm";
import { getTerminalTheme, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from "@clawtab/shared";
import type { TerminalTheme } from "@clawtab/shared";

export const TERMINAL_OPTIONS: ITerminalOptions = {
  fontSize: TERMINAL_FONT_SIZE,
  fontFamily: TERMINAL_FONT_FAMILY,
  lineHeight: TERMINAL_LINE_HEIGHT,
  letterSpacing: 0,
  rescaleOverlappingGlyphs: true,
  cursorStyle: "bar",
  cursorInactiveStyle: "bar",
  theme: getTerminalTheme(),
  allowProposedApi: true,
  scrollback: 10000,
};

export function applyTerminalRuntimeOptions(
  terminal: Terminal,
  container: HTMLElement,
  theme: TerminalTheme = getTerminalTheme(),
) {
  terminal.options.fontSize = TERMINAL_OPTIONS.fontSize;
  terminal.options.fontFamily = TERMINAL_OPTIONS.fontFamily;
  terminal.options.lineHeight = TERMINAL_OPTIONS.lineHeight;
  terminal.options.letterSpacing = TERMINAL_OPTIONS.letterSpacing;
  terminal.options.rescaleOverlappingGlyphs = TERMINAL_OPTIONS.rescaleOverlappingGlyphs;
  terminal.options.cursorStyle = TERMINAL_OPTIONS.cursorStyle;
  terminal.options.cursorInactiveStyle = TERMINAL_OPTIONS.cursorInactiveStyle;
  terminal.options.theme = theme;
  container.style.backgroundColor = theme.background ?? "";
  terminal.clearTextureAtlas();
  if (terminal.rows > 0) {
    terminal.refresh(0, terminal.rows - 1);
  }
}
