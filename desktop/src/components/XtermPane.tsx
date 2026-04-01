import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

// Tauri event names can't contain %, so sanitize pane IDs
function eventKey(paneId: string): string {
  return paneId.replace(/%/g, "p");
}

interface XtermPaneProps {
  paneId: string;
  tmuxSession: string;
  onExit?: () => void;
}

export function XtermPane({ paneId, tmuxSession, onExit }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el: HTMLDivElement = containerRef.current;

    let cancelled = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;
    let term: Terminal | null = null;
    let spawned = false;

    const key = eventKey(paneId);

    async function setup() {
      // Destroy any leftover PTY from a previous mount
      await invoke("pty_destroy", { paneId }).catch(() => {});
      if (cancelled) return;

      const t = new Terminal({
        fontSize: 12,
        fontFamily: "monospace",
        theme: {
          background: "#1a1a2e",
          foreground: "#e0e0e0",
          cursor: "#e0e0e0",
          cursorAccent: "#1a1a2e",
          selectionBackground: "rgba(255, 255, 255, 0.2)",
          black: "#1a1a2e",
          red: "#ff6b6b",
          green: "#51cf66",
          yellow: "#ffd43b",
          blue: "#74c0fc",
          magenta: "#da77f2",
          cyan: "#66d9e8",
          white: "#e0e0e0",
          brightBlack: "#555",
          brightRed: "#ff8787",
          brightGreen: "#69db7c",
          brightYellow: "#ffe066",
          brightBlue: "#91d5ff",
          brightMagenta: "#e599f7",
          brightCyan: "#99e9f2",
          brightWhite: "#ffffff",
        },
        allowProposedApi: true,
        scrollback: 10000,
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);

      try {
        t.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available
      }

      fit.fit();
      term = t;

      if (cancelled) { t.dispose(); return; }

      // Handle resize
      observer = new ResizeObserver(() => {
        fit.fit();
        invoke("pty_resize", {
          paneId,
          cols: t.cols,
          rows: t.rows,
        }).catch(() => {});
      });
      observer.observe(el);

      const cols = t.cols;
      const rows = t.rows;

      // Listen for output before spawning so we don't miss anything
      outputUnlisten = await listen<string>(`pty-output-${key}`, (event) => {
        const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
        t.write(bytes);
      });

      exitUnlisten = await listen(`pty-exit-${key}`, () => {
        onExit?.();
      });

      if (cancelled) return;

      await invoke("pty_spawn", { paneId, tmuxSession, cols, rows });
      spawned = true;

      if (cancelled) {
        invoke("pty_destroy", { paneId }).catch(() => {});
        return;
      }

      // Send input to PTY
      dataDisposable = t.onData((data) => {
        const encoded = btoa(data);
        invoke("pty_write", { paneId, data: encoded }).catch(() => {});
      });
    }

    setup().catch((err) => {
      console.error("XtermPane setup failed:", err);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      dataDisposable?.dispose();
      outputUnlisten?.();
      exitUnlisten?.();
      term?.dispose();
      if (spawned) {
        invoke("pty_destroy", { paneId }).catch(() => {});
      }
    };
  }, [paneId, tmuxSession]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => (f as unknown as { path?: string }).path)
        .filter(Boolean);
      if (paths.length > 0) {
        const text = paths
          .map((p) => `'${p!.replace(/'/g, "'\\''")}'`)
          .join(" ");
        const encoded = btoa(text);
        invoke("pty_write", { paneId, data: encoded }).catch(() => {});
      }
    },
    [paneId],
  );

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={handleDrop}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    />
  );
}
