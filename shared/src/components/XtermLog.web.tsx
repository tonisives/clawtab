import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

export interface XtermLogHandle {
  /** Write base64-encoded terminal data */
  write(b64: string): void;
  /** Get current terminal dimensions */
  dimensions(): { cols: number; rows: number };
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

    useImperativeHandle(ref, () => ({
      write(b64: string) {
        if (termRef.current) {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          termRef.current.write(bytes);
        }
      },
      dimensions() {
        const t = termRef.current;
        return { cols: t?.cols ?? 80, rows: t?.rows ?? 24 };
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      const el = containerRef.current;

      const t = new Terminal({
        fontSize: 12,
        fontFamily: "monospace",
        theme: {
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
        },
        allowProposedApi: true,
        scrollback: 10000,
        disableStdin: !interactive,
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);

      try {
        t.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available - canvas fallback
      }

      fit.fit();
      termRef.current = t;

      // Track previous dimensions to avoid spurious resizes from text selection
      let prevCols = t.cols;
      let prevRows = t.rows;

      const observer = new ResizeObserver(() => {
        fit.fit();
        if (t.cols !== prevCols || t.rows !== prevRows) {
          prevCols = t.cols;
          prevRows = t.rows;
          onResize?.(t.cols, t.rows);
        }
      });
      observer.observe(el);

      // Report initial size
      onResize?.(t.cols, t.rows);

      let dataDisposable: { dispose(): void } | null = null;
      if (interactive && onData) {
        dataDisposable = t.onData((data) => {
          onData(btoa(data));
        });
      }

      return () => {
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
