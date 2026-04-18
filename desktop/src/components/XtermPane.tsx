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
  normalizeShortcutBinding,
  resolveShortcutSettings,
  shortcutCompletesSequence,
  shortcutMatches,
  shortcutStartsWith,
  type ShortcutSettings,
} from "../shortcuts";

// Each pane's xterm + PTY connection is owned by a long-lived module instance
// rather than a React component. The React component is just a slot that
// physically appendChilds the persistent DOM container in/out of the layout.
//
// Why: when the split tree restructures (e.g. a leaf becomes a split), React
// unmounts the leaf component even if the leaf id is preserved, because the
// parent's child node identity changes from "render leaf" to "render split
// container". Without this indirection that triggers pty_destroy + pty_spawn
// for the same paneId, racing the reader thread on the backend, which produces
// garbled "wrong size" content or pane content swap symptoms.
type PaneInstance = {
  container: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  paneId: string;
  tmuxSession: string;
  resolvedGroup: string;
  refCount: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  attachGeneration: number | null;
  spawned: boolean;
  // Disposers that must run when the instance is finally torn down
  outputUnlisten: UnlistenFn | null;
  exitUnlisten: UnlistenFn | null;
  dropUnlisten: UnlistenFn | null;
  dataDisposable: { dispose(): void } | null;
  observer: ResizeObserver | null;
  observedEl: HTMLElement | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  focusInHandler: (() => void) | null;
  focusOutHandler: (() => void) | null;
  shortcutsRef: { current: ShortcutSettings };
  settingsUnlisten: UnlistenFn | null;
  pendingShortcutStrokeRef: { current: string | null };
  suppressedKeyRef: { current: string | null };
  onExitRef: { current: (() => void) | undefined };
  cancelled: boolean;
};

const paneInstances = new Map<string, PaneInstance>();
const RELEASE_GRACE_MS = 1500;

const pendingFocusPaneIds = new Set<string>();
let focusedPaneId: string | null = null;

function dispatchAppShortcut(binding: string, paneId: string, action?: string) {
  window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { action, binding, paneId } }));
}

export function requestXtermPaneFocus(paneId: string) {
  pendingFocusPaneIds.add(paneId);
  window.setTimeout(() => pendingFocusPaneIds.delete(paneId), 2000);
  const inst = paneInstances.get(paneId);
  if (!inst) return;
  inst.terminal.focus();
  window.requestAnimationFrame(() => inst.terminal.focus());
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

function createPaneInstance(paneId: string, tmuxSession: string, resolvedGroup: string): PaneInstance {
  const container = document.createElement("div");
  container.style.flex = "1";
  container.style.minHeight = "0";
  container.style.overflow = "hidden";
  container.style.width = "100%";
  container.style.height = "100%";

  const terminal = new Terminal({
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
  terminal.loadAddon(fit);
  terminal.open(container);

  const inst: PaneInstance = {
    container,
    terminal,
    fit,
    paneId,
    tmuxSession,
    resolvedGroup,
    refCount: 0,
    releaseTimer: null,
    attachGeneration: null,
    spawned: false,
    outputUnlisten: null,
    exitUnlisten: null,
    dropUnlisten: null,
    dataDisposable: null,
    observer: null,
    observedEl: null,
    refreshTimer: null,
    focusInHandler: null,
    focusOutHandler: null,
    shortcutsRef: { current: DEFAULT_SHORTCUTS },
    settingsUnlisten: null,
    pendingShortcutStrokeRef: { current: null },
    suppressedKeyRef: { current: null },
    onExitRef: { current: undefined },
    cancelled: false,
  };

  invoke<AppSettings>("get_settings")
    .then((settings) => {
      inst.shortcutsRef.current = resolveShortcutSettings(settings);
    })
    .catch(() => {
      inst.shortcutsRef.current = DEFAULT_SHORTCUTS;
    });

  listen<AppSettings>("settings-updated", (event) => {
    inst.shortcutsRef.current = resolveShortcutSettings(event.payload);
  }).then((fn) => {
    if (inst.cancelled) fn();
    else inst.settingsUnlisten = fn;
  }).catch(() => {});

  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") {
      if (inst.suppressedKeyRef.current && e.key === inst.suppressedKeyRef.current) {
        if (e.type === "keyup") inst.suppressedKeyRef.current = null;
        return false;
      }
      return true;
    }

    const shortcuts = inst.shortcutsRef.current;
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

    if (inst.pendingShortcutStrokeRef.current && e.key === "Escape") {
      inst.pendingShortcutStrokeRef.current = null;
      inst.suppressedKeyRef.current = "Escape";
      return false;
    }

    const stroke = eventToShortcutBinding(e);
    if (inst.pendingShortcutStrokeRef.current) {
      if (stroke) {
        const sequenceBinding = appBindings.find((binding) => (
          shortcutCompletesSequence(binding, [inst.pendingShortcutStrokeRef.current ?? "", stroke], shortcuts.prefix_key)
        ));
        if (sequenceBinding && !(e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled) {
          (e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled = true;
          const action = normalizeShortcutBinding(sequenceBinding, shortcuts.prefix_key) === normalizeShortcutBinding(shortcuts.rename_active_pane, shortcuts.prefix_key)
            ? "rename_active_pane"
            : undefined;
          dispatchAppShortcut(sequenceBinding, paneId, action);
        }
        inst.pendingShortcutStrokeRef.current = null;
        inst.suppressedKeyRef.current = e.key;
      }
      return false;
    }

    if (!stroke) return true;

    if (appBindings.some((binding) => shortcutStartsWith(binding, stroke, shortcuts.prefix_key))) {
      inst.pendingShortcutStrokeRef.current = stroke;
      inst.suppressedKeyRef.current = e.key;
      return false;
    }

    const singleStrokeBinding = appBindings.find((binding) => shortcutMatches(e, binding, shortcuts.prefix_key));
    if (singleStrokeBinding) {
      if (!(e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled) {
        const action = normalizeShortcutBinding(singleStrokeBinding, shortcuts.prefix_key) === normalizeShortcutBinding(shortcuts.rename_active_pane, shortcuts.prefix_key)
          ? "rename_active_pane"
          : undefined;
        dispatchAppShortcut(singleStrokeBinding, paneId, action);
      }
      inst.suppressedKeyRef.current = e.key;
      return false;
    }
    return true;
  });

  inst.focusInHandler = () => {
    focusedPaneId = paneId;
  };
  inst.focusOutHandler = () => {
    window.requestAnimationFrame(() => {
      if (!container.contains(document.activeElement) && focusedPaneId === paneId) {
        focusedPaneId = null;
      }
    });
  };
  container.addEventListener("focusin", inst.focusInHandler);
  container.addEventListener("focusout", inst.focusOutHandler);

  setupPaneInstance(inst).catch((err) => {
    console.error("XtermPane setup failed:", err);
  });

  return inst;
}

async function setupPaneInstance(inst: PaneInstance) {
  const setupStartedAt = performance.now();
  let firstOutputSeen = false;
  let firstContentOutputSeen = false;
  const elapsed = () => Math.round(performance.now() - setupStartedAt);
  const { paneId, tmuxSession, resolvedGroup, container, terminal, fit } = inst;
  const key = eventKey(paneId);
  debugXtermPane(paneId, "setup start", { tmuxSession, group: resolvedGroup });
  debugXtermPane(paneId, "terminal opened", { elapsedMs: elapsed() });

  if (pendingFocusPaneIds.has(paneId)) {
    requestXtermPaneFocus(paneId);
  }

  const cachedBytes = await invoke<number[]>("pty_get_cached_output", { paneId }).catch(() => []);
  if (inst.cancelled) return;
  debugXtermPane(paneId, "cache read", { elapsedMs: elapsed(), bytes: cachedBytes.length });
  if (cachedBytes.length > 0) {
    terminal.write(new Uint8Array(cachedBytes));
    debugXtermPane(paneId, "cache written", { elapsedMs: elapsed(), bytes: cachedBytes.length });
  }

  const viewport = await waitForViewportReady(container, terminal, fit, () => inst.cancelled);
  if (!viewport || inst.cancelled) return;
  const { cols, rows } = viewport;
  debugXtermPane(paneId, "viewport ready", { elapsedMs: elapsed(), cols, rows });

  inst.outputUnlisten = await listen<number[]>(`pty-output-${key}`, (event) => {
    if (!firstOutputSeen) {
      firstOutputSeen = true;
      debugXtermPane(paneId, "first pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
    }
    if (!firstContentOutputSeen && event.payload.length > 3) {
      firstContentOutputSeen = true;
      debugXtermPane(paneId, "first content pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
    }
    terminal.write(new Uint8Array(event.payload));
  });
  debugXtermPane(paneId, "output listener ready", { elapsedMs: elapsed(), event: `pty-output-${key}` });

  inst.exitUnlisten = await listen(`pty-exit-${key}`, () => {
    inst.onExitRef.current?.();
  });

  if (inst.cancelled) return;

  let result: PtySpawnResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (inst.cancelled) return;
    try {
      result = await invoke<PtySpawnResult>("pty_spawn", {
        paneId, tmuxSession, cols, rows, group: resolvedGroup,
      });
      break;
    } catch (err) {
      debugXtermPane(paneId, `pty_spawn attempt ${attempt + 1} failed`, { elapsedMs: elapsed(), error: String(err) });
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  if (!result) return;
  inst.attachGeneration = result.attach_generation;
  inst.spawned = true;
  debugXtermPane(paneId, "pty_spawn returned", {
    elapsedMs: elapsed(),
    attachGeneration: result.attach_generation,
    nativeCols: result.native_cols,
    nativeRows: result.native_rows,
  });

  if (inst.cancelled) {
    invoke("pty_destroy", { paneId, attachGeneration: result.attach_generation }).catch(() => {});
    return;
  }

  inst.refreshTimer = setTimeout(() => {
    if (inst.cancelled || firstContentOutputSeen) return;
    debugXtermPane(paneId, "watchdog: no content at 500ms, requesting snapshot", { elapsedMs: elapsed() });
    invoke("pty_refresh_snapshot", { paneId }).catch(() => {});

    inst.refreshTimer = setTimeout(async () => {
      if (inst.cancelled || firstContentOutputSeen) return;
      debugXtermPane(paneId, "watchdog: no content at 2s, forcing re-spawn", { elapsedMs: elapsed() });
      const gen = inst.attachGeneration;
      await invoke("pty_destroy", { paneId, attachGeneration: gen }).catch(() => {});
      if (inst.cancelled || firstContentOutputSeen) return;
      const retry = await invoke<PtySpawnResult>("pty_spawn", {
        paneId, tmuxSession, cols: terminal.cols, rows: terminal.rows, group: resolvedGroup,
      }).catch(() => null);
      if (retry) {
        inst.attachGeneration = retry.attach_generation;
      }
    }, 1500);
  }, 500);

  if (result.native_cols !== cols || result.native_rows !== rows) {
    console.log(
      `[XtermPane] native ${result.native_cols}x${result.native_rows}, viewport ${cols}x${rows} - resize will trigger reflow`
    );
  }

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let prevWidth = 0;
  let prevHeight = 0;
  let prevCols = cols;
  let prevRows = rows;

  requestAnimationFrame(() => {
    if (inst.cancelled) return;
    fit.fit();
    if (terminal.cols !== prevCols || terminal.rows !== prevRows) {
      prevCols = terminal.cols;
      prevRows = terminal.rows;
      invoke("pty_resize", { paneId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    }
  });

  inst.observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (width === prevWidth && height === prevHeight) return;
    prevWidth = width;
    prevHeight = height;
    fit.fit();
    if (terminal.cols === prevCols && terminal.rows === prevRows) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      prevCols = terminal.cols;
      prevRows = terminal.rows;
      invoke("pty_resize", {
        paneId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {});
    }, 150);
  });
  inst.observer.observe(container);
  inst.observedEl = container;

  const utf8Encoder = new TextEncoder();
  const encodeUtf8Base64 = (s: string) => {
    const bytes = utf8Encoder.encode(s);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };
  let inputBuf = "";
  let inputScheduled = false;
  inst.dataDisposable = terminal.onData((data) => {
    inputBuf += data;
    if (!inputScheduled) {
      inputScheduled = true;
      Promise.resolve().then(() => {
        const batch = inputBuf;
        inputBuf = "";
        inputScheduled = false;
        const encoded = encodeUtf8Base64(batch);
        invoke("pty_write", { paneId, data: encoded }).catch(() => {});
      });
    }
  });

  inst.dropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type !== "drop" || p.paths.length === 0) return;
    const rect = container.getBoundingClientRect();
    const { x, y } = p.position;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const text = p.paths
      .map((fp: string) => `'${fp.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const encoded = encodeUtf8Base64(text);
    invoke("pty_write", { paneId, data: encoded }).catch(() => {});
  });
}

function teardownPaneInstance(inst: PaneInstance) {
  inst.cancelled = true;
  const { paneId, container } = inst;
  if (inst.focusInHandler) container.removeEventListener("focusin", inst.focusInHandler);
  if (inst.focusOutHandler) container.removeEventListener("focusout", inst.focusOutHandler);
  if (inst.refreshTimer) clearTimeout(inst.refreshTimer);
  inst.observer?.disconnect();
  inst.dataDisposable?.dispose();
  inst.outputUnlisten?.();
  inst.exitUnlisten?.();
  inst.dropUnlisten?.();
  inst.settingsUnlisten?.();
  inst.terminal.dispose();
  if (container.parentNode) container.parentNode.removeChild(container);
  const attachGeneration = inst.attachGeneration;
  inst.attachGeneration = null;
  if (attachGeneration != null) {
    debugXtermPane(paneId, "destroy", { attachGeneration });
    invoke("pty_destroy", { paneId, attachGeneration }).catch(() => {});
  }
}

function acquirePane(paneId: string, tmuxSession: string, resolvedGroup: string): PaneInstance {
  let inst = paneInstances.get(paneId);
  const created = !inst;
  if (!inst) {
    inst = createPaneInstance(paneId, tmuxSession, resolvedGroup);
    paneInstances.set(paneId, inst);
  }
  if (inst.releaseTimer) {
    clearTimeout(inst.releaseTimer);
    inst.releaseTimer = null;
  }
  inst.refCount += 1;
  debugXtermPane(paneId, `acquire refCount=${inst.refCount} created=${created} registrySize=${paneInstances.size}`);
  return inst;
}

function releasePane(paneId: string) {
  const inst = paneInstances.get(paneId);
  if (!inst) return;
  inst.refCount -= 1;
  debugXtermPane(paneId, `release refCount=${inst.refCount}`);
  if (inst.refCount > 0) return;
  if (inst.releaseTimer) clearTimeout(inst.releaseTimer);
  inst.releaseTimer = setTimeout(() => {
    if (inst.refCount > 0) return;
    paneInstances.delete(paneId);
    teardownPaneInstance(inst);
  }, RELEASE_GRACE_MS);
}

export const XtermPane = memo(function XtermPane({ paneId, tmuxSession, group, onExit }: XtermPaneProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const resolvedGroup = group ?? "default";

  useEffect(() => {
    if (!slotRef.current) return;
    const slot = slotRef.current;
    const inst = acquirePane(paneId, tmuxSession, resolvedGroup);
    inst.onExitRef = onExitRef;
    const slotId = slot.closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
    const prevParent = inst.container.parentNode;
    if (prevParent === slot) {
      debugXtermPane(paneId, `same-slot remount into leaf ${slotId}, skipping appendChild`);
    } else {
      if (prevParent) {
        const prevSlotId = (prevParent as HTMLElement).closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
        debugXtermPane(paneId, `container moving leaf ${prevSlotId} -> ${slotId}`);
      } else {
        debugXtermPane(paneId, `mount into leaf ${slotId} (prevParent=none)`);
      }
      slot.appendChild(inst.container);
    }
    // Fit synchronously now, then again on the next frame after layout settles.
    // Split-tree restructure can move the container into a slot whose width/height
    // is still mid-reflow; the second fit ensures the terminal matches the final
    // visible size and avoids the "stale content" symptom that zoom-out/in fixes.
    inst.fit.fit();
    const fitRaf = requestAnimationFrame(() => {
      if (inst.cancelled) return;
      inst.fit.fit();
    });

    // If a focus was requested before this pane mounted (e.g. immediately after
    // split/fork), apply it now that the terminal's DOM is in the layout.
    if (pendingFocusPaneIds.has(paneId)) {
      requestXtermPaneFocus(paneId);
    }

    return () => {
      cancelAnimationFrame(fitRaf);
      const curLeafId = slot.closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
      debugXtermPane(paneId, `unmount from leaf ${curLeafId} (containerParent=${inst.container.parentNode === slot ? "same" : inst.container.parentNode ? "other" : "none"})`);
      if (inst.container.parentNode === slot) {
        slot.removeChild(inst.container);
      }
      releasePane(paneId);
    };
  }, [paneId, tmuxSession, resolvedGroup]);

  return (
    <div
      ref={slotRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
      }}
    />
  );
});
