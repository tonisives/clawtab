import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  getTerminalTheme,
  subscribeTerminalThemeChange,
  TERMINAL_CUSTOM_GLYPHS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
} from "../theme/terminal";

export interface XtermLogHandle {
  /** Write base64-encoded terminal data */
  write(b64: string): void;
  /** Write plain text (normalises \n to \r\n for xterm) */
  writeText(text: string): void;
  /** Reset terminal state */
  clear(): void;
  /** Get current terminal dimensions */
  dimensions(): { cols: number; rows: number };
  /** Visually offset terminal contents without resizing the container */
  setVisualOffset(px: number): void;
  /** Blur the terminal input so native keyboards close */
  blur(): void;
  /** Focus the terminal input */
  focus(): void;
  /** Focuses the hidden paste target on native; no-op on web */
  showPasteMenu(): void;
}

interface XtermLogProps {
  /** Called when user types (base64-encoded) */
  onData?: (b64: string) => void;
  /** Called when terminal resizes */
  onResize?: (cols: number, rows: number) => void;
  /** Whether terminal accepts input (default true) */
  interactive?: boolean;
}

export const XtermLog = forwardRef<XtermLogHandle, XtermLogProps>(
  function XtermLog({ onData, onResize, interactive = true }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    const interactiveRef = useRef(interactive);
    const visualOffsetMaxRef = useRef(0);

    const enforceCursorStyle = () => {
      const t = termRef.current;
      if (!t) return;
      t.options.cursorStyle = "bar";
      t.options.cursorInactiveStyle = "bar";
    };

    const applyVisualOffset = () => {
      const t = termRef.current;
      const el = containerRef.current;
      if (!t || !el) return;
      enforceCursorStyle();
      const maxPx = Math.max(0, Math.round(visualOffsetMaxRef.current));
      const rowHeight = el.clientHeight / Math.max(1, t.rows);
      let lastContentY = -1;
      for (let y = t.rows - 1; y >= 0; y--) {
        const line = t.buffer.active.getLine(t.buffer.active.viewportY + y);
        if (line?.translateToString(true).trim()) {
          lastContentY = y;
          break;
        }
      }
      if (lastContentY < 0) lastContentY = 0;
      const contentBottom = (lastContentY + 1) * rowHeight;
      const visibleHeight = Math.max(0, el.clientHeight - maxPx);
      const offset = Math.max(0, Math.min(maxPx, Math.ceil(contentBottom - visibleHeight)));
      el.style.transform = offset ? `translate3d(0, ${-offset}px, 0)` : "";
      el.style.transition = "transform 180ms ease-out";
    };

    useEffect(() => {
      onDataRef.current = onData;
      onResizeRef.current = onResize;
      interactiveRef.current = interactive;
      if (termRef.current) termRef.current.options.disableStdin = !interactive;
    }, [interactive, onData, onResize]);

    useImperativeHandle(ref, () => ({
      write(b64: string) {
        if (termRef.current) {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          termRef.current.write(bytes, applyVisualOffset);
        }
      },
      writeText(text: string) {
        termRef.current?.write(text.replace(/\r?\n/g, "\r\n"), applyVisualOffset);
      },
      clear() {
        termRef.current?.reset();
      },
      dimensions() {
        const t = termRef.current;
        return { cols: t?.cols ?? 80, rows: t?.rows ?? 24 };
      },
      setVisualOffset(px: number) {
        visualOffsetMaxRef.current = Math.max(0, Math.round(px));
        applyVisualOffset();
      },
      blur() {
        termRef.current?.blur();
      },
      focus() {
        termRef.current?.focus();
      },
      showPasteMenu() {},
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      const el = containerRef.current;
      const initialTheme = getTerminalTheme();

      const t = new Terminal({
        fontSize: TERMINAL_FONT_SIZE,
        fontFamily: TERMINAL_FONT_FAMILY,
        lineHeight: TERMINAL_LINE_HEIGHT,
        letterSpacing: 0,
        customGlyphs: TERMINAL_CUSTOM_GLYPHS,
        rescaleOverlappingGlyphs: true,
        cursorStyle: "bar",
        cursorInactiveStyle: "bar",
        theme: initialTheme,
        allowProposedApi: true,
        scrollback: 10000,
        disableStdin: !interactive,
      });
      el.style.backgroundColor = initialTheme.background ?? "";

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);

      fit.fit();
      termRef.current = t;

      // Track previous dimensions to avoid spurious resizes from text selection
      let prevWidth = 0;
      let prevHeight = 0;
      let prevCols = t.cols;
      let prevRows = t.rows;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (width === prevWidth && height === prevHeight) return;
        prevWidth = width;
        prevHeight = height;
        fit.fit();
        if (t.cols !== prevCols || t.rows !== prevRows) {
          prevCols = t.cols;
          prevRows = t.rows;
          onResizeRef.current?.(t.cols, t.rows);
        }
      });
      observer.observe(el);

      // Report initial size
      onResizeRef.current?.(t.cols, t.rows);

      const unsubscribeTheme = subscribeTerminalThemeChange((theme) => {
        t.options.theme = theme;
        el.style.backgroundColor = theme.background ?? "";
        if (t.rows > 0) t.refresh(0, t.rows - 1);
      });

      let dataDisposable: { dispose(): void } | null = null;
      dataDisposable = t.onData((data) => {
        if (!interactiveRef.current) return;
        onDataRef.current?.(btoa(data));
      });

      return () => {
        unsubscribeTheme();
        observer.disconnect();
        dataDisposable?.dispose();
        t.dispose();
        termRef.current = null;
      };
    }, []); // mount once

    return (
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      />
    );
  },
);
