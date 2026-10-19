import type { TerminalScrollState } from "../util/terminalTouchScroll";
import { attachTerminalTouchScroll } from "../util/terminalTouchScroll";
import { encodeTerminalInput } from "../util/terminalInput";
import { useRef, useEffect, useImperativeHandle, useState, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./XtermLog.web.css";
import {
  DARK_TERMINAL_THEME,
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
  setScreenSize(size: { cols: number; rows: number } | null): void;
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
  /** Use the dark app terminal even when the browser prefers a light color scheme. */
  forceDarkTheme?: boolean;
  extendedViewport?: boolean;
  extendedViewportHeight?: number;
}

export const XtermLog = forwardRef<XtermLogHandle, XtermLogProps>(
  function XtermLog({ onData, onResize, interactive = true, forceDarkTheme = false }, ref) {
    let [scrollState, setScrollState] = useState<TerminalScrollState>({ atStart: true, atEnd: true, scrollable: false, boundaryReached: false });
    let scrollRef = useRef<ReturnType<typeof attachTerminalTouchScroll> | null>(null);
    let scrollPage = (direction: number) => {
      scrollRef.current?.scroll(direction * (containerRef.current?.clientHeight ?? 0) / 2);
      termRef.current?.focus();
    };
    let scrollUp = () => scrollPage(-1);
    let scrollDown = () => scrollPage(1);
    const containerRef = useRef<HTMLDivElement>(null);
    let screenSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    let fitRef = useRef<FitAddon | null>(null);
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
      setScreenSize(size) {
        screenSizeRef.current = size;
        if (size) termRef.current?.resize(size.cols, size.rows);
        else fitRef.current?.fit();
      },
      dimensions() {
        let physical = fitRef.current?.proposeDimensions();
        if (physical) return physical;
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
      const initialTheme = forceDarkTheme ? DARK_TERMINAL_THEME : getTerminalTheme();

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
      fitRef.current = fit;
      t.loadAddon(fit);
      t.open(el);

      fit.fit();
      termRef.current = t;
      let detachTouchScroll = attachTerminalTouchScroll(el, t, (next) => {
        setScrollState((previous) => previous.atStart === next.atStart && previous.atEnd === next.atEnd && previous.scrollable === next.scrollable && previous.boundaryReached === next.boundaryReached ? previous : next);
      });
      scrollRef.current = detachTouchScroll;
      t.attachCustomKeyEventHandler((event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !["u", "d"].includes(event.key.toLowerCase())) return true;
        let screen = el.querySelector<HTMLElement>(".xterm-screen");
        let scrollable = t.buffer.active.baseY > 0 || (screen?.clientHeight ?? 0) > el.clientHeight;
        if (!scrollable) return true;
        if (event.type === "keydown") {
          event.preventDefault();
          detachTouchScroll.scroll((event.key.toLowerCase() === "u" ? -1 : 1) * el.clientHeight / 2);
        }
        return false;
      });
      let scrollDisposable = t.onScroll(() => detachTouchScroll.refresh());
      let renderDisposable = t.onRender(() => detachTouchScroll.refresh());

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
        let physical = fit.proposeDimensions();
        let fixed = screenSizeRef.current;
        if (fixed) {
          t.resize(fixed.cols, fixed.rows);
          if (physical) onResizeRef.current?.(physical.cols, physical.rows);
          return;
        }
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

      const unsubscribeTheme = forceDarkTheme
        ? () => {}
        : subscribeTerminalThemeChange((theme) => {
            t.options.theme = theme;
            el.style.backgroundColor = theme.background ?? "";
            if (t.rows > 0) t.refresh(0, t.rows - 1);
          });

      let dataDisposable: { dispose(): void } | null = null;
      dataDisposable = t.onData((data) => {
        if (!interactiveRef.current) return;
        onDataRef.current?.(encodeTerminalInput(data));
      });

      return () => {
        unsubscribeTheme();
        observer.disconnect();
        detachTouchScroll();
        scrollRef.current = null;
        scrollDisposable.dispose();
        renderDisposable.dispose();
        dataDisposable?.dispose();
        t.dispose();
        termRef.current = null;
      };
    }, [forceDarkTheme]);

    return (
      <div className="terminal-frame">
        <div ref={containerRef} className="terminal-buffer" />
        {scrollState.scrollable && scrollState.boundaryReached ? <div className="terminal-scroll-controls" role="group" aria-label="Terminal scrolling">
          <button type="button" onClick={scrollUp} disabled={scrollState.atStart} aria-label="Scroll up half a page" title="Scroll up (Ctrl+U)">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
          </button>
          <button type="button" onClick={scrollDown} disabled={scrollState.atEnd} aria-label="Scroll down half a page" title="Scroll down (Ctrl+D)">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
        </div> : null}
      </div>
    );
  },
);
