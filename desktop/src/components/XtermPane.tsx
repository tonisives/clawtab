import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";

// Tauri event names can't contain %, so sanitize pane IDs
function eventKey(paneId: string): string {
  return paneId.replace(/%/g, "p");
}

interface XtermPaneProps {
  paneId: string;
  tmuxSession: string;
  group?: string;
  onExit?: () => void;
}

interface PtySpawnResult {
  native_cols: number;
  native_rows: number;
}

export const XtermPane = memo(function XtermPane({ paneId, tmuxSession, group, onExit }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedGroup = group ?? "default";

  useEffect(() => {
    if (!containerRef.current) return;
    const el: HTMLDivElement = containerRef.current;

    let cancelled = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let dropUnlisten: UnlistenFn | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;
    let term: Terminal | null = null;
    let spawned = false;
    const key = eventKey(paneId);

    async function setup() {
      // Destroy any leftover viewer from a previous mount
      await invoke("pty_destroy", { paneId }).catch(() => {});
      if (cancelled) return;

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
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);

      // Let our app shortcuts pass through instead of being consumed by the terminal
      t.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        // Cmd+E: toggle sidebar
        if (e.metaKey && e.key === "e") return false;
        // Ctrl+V/S: split pane
        if (e.ctrlKey && (e.key === "v" || e.key === "s")) return false;
        // Cmd+H/J/K/L: move between panes
        if (e.metaKey && "hjkl".includes(e.key)) return false;
        return true;
      });

      fit.fit();
      term = t;

      if (cancelled) { t.dispose(); return; }

      const cols = t.cols;
      const rows = t.rows;

      // Listen for output before spawning so we don't miss the initial capture
      outputUnlisten = await listen<number[]>(`pty-output-${key}`, (event) => {
        t.write(new Uint8Array(event.payload));
      });

      exitUnlisten = await listen(`pty-exit-${key}`, () => {
        onExit?.();
      });

      if (cancelled) return;

      // Spawn captures the pane into clawtab-<group>, opens a local PTY
      // running `tmux attach-session` on an ephemeral view session, and
      // streams bytes via pty-output events.
      const result = await invoke<PtySpawnResult>("pty_spawn", {
        paneId, tmuxSession, cols, rows, group: resolvedGroup,
      });
      spawned = true;

      if (cancelled) {
        invoke("pty_destroy", { paneId }).catch(() => {});
        return;
      }

      // Backend reflows the captured window directly on resize. If viewport
      // differs from native size, ResizeObserver will trigger pty_resize.
      if (result.native_cols !== cols || result.native_rows !== rows) {
        console.log(
          `[XtermPane] native ${result.native_cols}x${result.native_rows}, viewport ${cols}x${rows} - resize will trigger reflow`
        );
      }

      // Resize the tmux pane when the container changes size.
      // Debounced to avoid spamming during drag. Skip no-op resizes
      // (spawn already resized to viewport dimensions).
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      let prevWidth = 0;
      let prevHeight = 0;
      let prevCols = cols;
      let prevRows = rows;
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (width === prevWidth && height === prevHeight) return;
        prevWidth = width;
        prevHeight = height;
        fit.fit();
        if (t.cols === prevCols && t.rows === prevRows) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          prevCols = t.cols;
          prevRows = t.rows;
          invoke("pty_resize", {
            paneId,
            cols: t.cols,
            rows: t.rows,
          }).catch(() => {});
        }, 150);
      });
      observer.observe(el);

      // Send input to the real tmux pane, batching rapid keystrokes
      // (e.g. paste) into fewer IPC calls to reduce subprocess spawns.
      let inputBuf = "";
      let inputScheduled = false;
      dataDisposable = t.onData((data) => {
        inputBuf += data;
        if (!inputScheduled) {
          inputScheduled = true;
          Promise.resolve().then(() => {
            const batch = inputBuf;
            inputBuf = "";
            inputScheduled = false;
            const encoded = btoa(batch);
            invoke("pty_write", { paneId, data: encoded }).catch(() => {});
          });
        }
      });

      // Handle file drag-and-drop via Tauri's native API
      dropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop" || p.paths.length === 0) return;
        const rect = el.getBoundingClientRect();
        const { x, y } = p.position;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        const text = p.paths
          .map((fp: string) => `'${fp.replace(/'/g, "'\\''")}'`)
          .join(" ");
        const encoded = btoa(text);
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
      dropUnlisten?.();
      term?.dispose();
      if (spawned) {
        invoke("pty_destroy", { paneId }).catch(() => {});
      }
    };
  }, [paneId, tmuxSession, resolvedGroup]);

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
});
