import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
import type { AppSettings } from "../types";
import {
  APP_SHORTCUT_EVENT,
  DEFAULT_SHORTCUTS,
  eventToShortcutBinding,
  resolveShortcutSettings,
  shortcutMatches,
  shortcutStartsWith,
} from "../shortcuts";

const pendingDestroyTimers = new Map<string, number>();
// Tracks pane IDs whose xterm had DOM focus at the moment of unmount, so a
// remount (e.g. shell promoted to detected process swaps the detail component)
// can re-focus the new terminal and preserve the user's typing position.
const pendingFocusPaneIds = new Set<string>();
let focusedPaneId: string | null = null;
const activeTerminals = new Map<string, Terminal>();

function dispatchAppShortcut(binding: string, paneId: string) {
  window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { binding, paneId } }));
}

export function requestXtermPaneFocus(paneId: string) {
  pendingFocusPaneIds.add(paneId);
  window.setTimeout(() => pendingFocusPaneIds.delete(paneId), 2000);
  const terminal = activeTerminals.get(paneId);
  if (!terminal) return;
  terminal.focus();
  window.requestAnimationFrame(() => terminal.focus());
}

// Tauri event names can't contain %, so sanitize pane IDs
function eventKey(paneId: string): string {
  return paneId.replace(/%/g, "p");
}

function debugXtermPane(paneId: string, message: string, details?: Record<string, unknown>) {
  if (details) {
    console.debug(`[XtermPane ${paneId}] ${message}`, details);
  } else {
    console.debug(`[XtermPane ${paneId}] ${message}`);
  }
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
  attach_generation: number;
}

async function waitForViewportReady(
  el: HTMLDivElement,
  term: Terminal,
  fit: FitAddon,
  isCancelled: () => boolean,
): Promise<{ cols: number; rows: number } | null> {
  const measure = () => {
    fit.fit();
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    if (term.cols < 2 || term.rows < 2) return null;
    return { cols: term.cols, rows: term.rows };
  };

  const initial = measure();
  if (initial) return initial;

  return await new Promise((resolve) => {
    let settled = false;
    let rafId = 0;
    let resizeObserver: ResizeObserver | null = null;

    const finish = (value: { cols: number; rows: number } | null) => {
      if (settled) return;
      settled = true;
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      resolve(value);
    };

    const check = () => {
      if (isCancelled()) {
        finish(null);
        return;
      }
      const size = measure();
      if (size) {
        finish(size);
        return;
      }
      rafId = requestAnimationFrame(check);
    };

    resizeObserver = new ResizeObserver(() => {
      const size = measure();
      if (size) finish(size);
    });
    resizeObserver.observe(el);
    rafId = requestAnimationFrame(check);
  });
}

export const XtermPane = memo(function XtermPane({ paneId, tmuxSession, group, onExit }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const shortcutsRef = useRef(DEFAULT_SHORTCUTS);
  const pendingShortcutStrokeRef = useRef<string | null>(null);
  const suppressedKeyRef = useRef<string | null>(null);
  const resolvedGroup = group ?? "default";
  const attachGenerationRef = useRef<number | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        shortcutsRef.current = resolveShortcutSettings(settings);
      })
      .catch(() => {
        shortcutsRef.current = DEFAULT_SHORTCUTS;
      });

    const unlistenPromise = listen<AppSettings>("settings-updated", (event) => {
      shortcutsRef.current = resolveShortcutSettings(event.payload);
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const el: HTMLDivElement = containerRef.current;
    const pendingDestroy = pendingDestroyTimers.get(paneId);
    if (pendingDestroy != null) {
      window.clearTimeout(pendingDestroy);
      pendingDestroyTimers.delete(paneId);
    }

    let cancelled = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let dropUnlisten: UnlistenFn | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;
    let term: Terminal | null = null;
    let focusInHandler: (() => void) | null = null;
    let focusOutHandler: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const key = eventKey(paneId);

    async function setup() {
      const setupStartedAt = performance.now();
      let firstOutputSeen = false;
      let firstContentOutputSeen = false;
      const elapsed = () => Math.round(performance.now() - setupStartedAt);
      debugXtermPane(paneId, "setup start", { tmuxSession, group: resolvedGroup });

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
      debugXtermPane(paneId, "terminal opened", { elapsedMs: elapsed() });

      // Let our app shortcuts pass through instead of being consumed by the terminal
      t.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") {
          if (suppressedKeyRef.current && e.key === suppressedKeyRef.current) {
            if (e.type === "keyup") suppressedKeyRef.current = null;
            return false;
          }
          return true;
        }

        const shortcuts = shortcutsRef.current;
        const appBindings = [
          shortcuts.next_sidebar_item,
          shortcuts.previous_sidebar_item,
          shortcuts.toggle_sidebar,
          shortcuts.rename_active_pane,
          shortcuts.focus_agent_input,
          shortcuts.zoom_active_pane,
          shortcuts.split_pane_vertical,
          shortcuts.split_pane_horizontal,
          shortcuts.kill_pane,
          shortcuts.move_pane_left,
          shortcuts.move_pane_down,
          shortcuts.move_pane_up,
          shortcuts.move_pane_right,
          shortcuts.reveal_in_sidebar,
          shortcuts.toggle_auto_yes,
        ];

        if (pendingShortcutStrokeRef.current && e.key === "Escape") {
          pendingShortcutStrokeRef.current = null;
          suppressedKeyRef.current = "Escape";
          return false;
        }

        const stroke = eventToShortcutBinding(e);
        if (pendingShortcutStrokeRef.current) {
          if (stroke) {
            pendingShortcutStrokeRef.current = null;
            suppressedKeyRef.current = e.key;
          }
          return false;
        }

        if (!stroke) return true;

        if (appBindings.some((binding) => shortcutStartsWith(binding, stroke, shortcuts.prefix_key))) {
          pendingShortcutStrokeRef.current = stroke;
          suppressedKeyRef.current = e.key;
          return false;
        }

        const singleStrokeBinding = appBindings.find((binding) => shortcutMatches(e, binding, shortcuts.prefix_key));
        console.log("[xterm key]", eventToShortcutBinding(e), "matched:", singleStrokeBinding ?? "none");
        if (singleStrokeBinding) {
          if (!(e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled) {
            dispatchAppShortcut(singleStrokeBinding, paneId);
          }
          suppressedKeyRef.current = e.key;
          return false;
        }
        return true;
      });

      fit.fit();
      term = t;
      activeTerminals.set(paneId, t);
      focusInHandler = () => {
        focusedPaneId = paneId;
      };
      focusOutHandler = () => {
        window.requestAnimationFrame(() => {
          if (!el.contains(document.activeElement) && focusedPaneId === paneId) {
            focusedPaneId = null;
          }
        });
      };
      el.addEventListener("focusin", focusInHandler);
      el.addEventListener("focusout", focusOutHandler);

      if (cancelled) { t.dispose(); return; }

      // If this pane's terminal had focus at the last unmount (e.g. a shell
      // was just promoted to a detected process and the detail component
      // swapped), restore input focus to the new xterm instance.
      if (pendingFocusPaneIds.has(paneId)) {
        requestXtermPaneFocus(paneId);
      }

      const cachedBytes = await invoke<number[]>("pty_get_cached_output", { paneId }).catch(() => []);
      if (cancelled) {
        t.dispose();
        return;
      }
      debugXtermPane(paneId, "cache read", { elapsedMs: elapsed(), bytes: cachedBytes.length });
      if (cachedBytes.length > 0) {
        t.write(new Uint8Array(cachedBytes));
        debugXtermPane(paneId, "cache written", { elapsedMs: elapsed(), bytes: cachedBytes.length });
      }

      const viewport = await waitForViewportReady(el, t, fit, () => cancelled);
      if (!viewport || cancelled) {
        t.dispose();
        return;
      }
      const { cols, rows } = viewport;
      debugXtermPane(paneId, "viewport ready", { elapsedMs: elapsed(), cols, rows });

      // Listen for output before spawning so we don't miss the initial capture
      outputUnlisten = await listen<number[]>(`pty-output-${key}`, (event) => {
        if (!firstOutputSeen) {
          firstOutputSeen = true;
          debugXtermPane(paneId, "first pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
        }
        if (!firstContentOutputSeen && event.payload.length > 3) {
          firstContentOutputSeen = true;
          debugXtermPane(paneId, "first content pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
        }
        t.write(new Uint8Array(event.payload));
      });
      debugXtermPane(paneId, "output listener ready", { elapsedMs: elapsed(), event: `pty-output-${key}` });

      exitUnlisten = await listen(`pty-exit-${key}`, () => {
        onExitRef.current?.();
      });

      if (cancelled) return;

      // Spawn captures the pane into clawtab-<group>, opens a local PTY
      // running `tmux attach-session` on an ephemeral view session, and
      // streams bytes via pty-output events.
      const result = await invoke<PtySpawnResult>("pty_spawn", {
        paneId, tmuxSession, cols, rows, group: resolvedGroup,
      });
      attachGenerationRef.current = result.attach_generation;
      debugXtermPane(paneId, "pty_spawn returned", {
        elapsedMs: elapsed(),
        attachGeneration: result.attach_generation,
        nativeCols: result.native_cols,
        nativeRows: result.native_rows,
      });

      if (cancelled) {
        invoke("pty_destroy", { paneId, attachGeneration: result.attach_generation }).catch(() => {});
        return;
      }

      // Watchdog: escalating retries if no content arrives after spawn.
      // 500ms - request a fresh snapshot (covers lost initial event).
      // 2000ms - destroy + re-spawn (covers dead reader thread / zombie viewer).
      refreshTimer = setTimeout(() => {
        if (cancelled || firstContentOutputSeen) return;
        debugXtermPane(paneId, "watchdog: no content at 500ms, requesting snapshot", { elapsedMs: elapsed() });
        invoke("pty_refresh_snapshot", { paneId }).catch(() => {});

        refreshTimer = setTimeout(async () => {
          if (cancelled || firstContentOutputSeen) return;
          debugXtermPane(paneId, "watchdog: no content at 2s, forcing re-spawn", { elapsedMs: elapsed() });
          const gen = attachGenerationRef.current;
          await invoke("pty_destroy", { paneId, attachGeneration: gen }).catch(() => {});
          if (cancelled || firstContentOutputSeen) return;
          const retry = await invoke<PtySpawnResult>("pty_spawn", {
            paneId, tmuxSession, cols: t.cols, rows: t.rows, group: resolvedGroup,
          }).catch(() => null);
          if (retry) {
            attachGenerationRef.current = retry.attach_generation;
          }
        }, 1500);
      }, 500);

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

      // After spawn, the container may have settled to its final layout dimensions
      // (especially when transitioning from a placeholder view). Do a deferred fit
      // to catch any size change that occurred during the async spawn round-trip.
      requestAnimationFrame(() => {
        if (cancelled) return;
        fit.fit();
        if (t.cols !== prevCols || t.rows !== prevRows) {
          prevCols = t.cols;
          prevRows = t.rows;
          invoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }).catch(() => {});
        }
      });

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
      // If the terminal currently has DOM focus, mark this pane so the next
      // mount (same paneId) can restore focus. Covers shell->process promotion
      // and any other parent-component swap that keeps the same underlying pane.
      // Clears itself after 2s if no remount happens, so a stale flag can't
      // surprise-focus a later re-open of the same pane id.
      const termEl = el.querySelector("textarea");
      if ((termEl && document.activeElement === termEl) || focusedPaneId === paneId) {
        pendingFocusPaneIds.add(paneId);
        window.setTimeout(() => pendingFocusPaneIds.delete(paneId), 2000);
      }
      if (focusInHandler) el.removeEventListener("focusin", focusInHandler);
      if (focusOutHandler) el.removeEventListener("focusout", focusOutHandler);
      if (activeTerminals.get(paneId) === term) {
        activeTerminals.delete(paneId);
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      observer?.disconnect();
      dataDisposable?.dispose();
      outputUnlisten?.();
      exitUnlisten?.();
      dropUnlisten?.();
      term?.dispose();
      const attachGeneration = attachGenerationRef.current;
      attachGenerationRef.current = null;
      if (attachGeneration != null) {
        const timer = window.setTimeout(() => {
          pendingDestroyTimers.delete(paneId);
          debugXtermPane(paneId, "destroy timer fired", { attachGeneration });
          invoke("pty_destroy", { paneId, attachGeneration }).catch(() => {});
        }, 300);
        pendingDestroyTimers.set(paneId, timer);
      }
    };
    // The viewer lifecycle is keyed by the tmux pane id. Parent polling can
    // refresh tmux session metadata without changing the actual pane, and
    // re-spawning here causes a visible terminal reset.
  }, [paneId]);

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
