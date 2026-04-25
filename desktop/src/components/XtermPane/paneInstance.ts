import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import type { AppSettings } from "../../types";
import { DEFAULT_SHORTCUTS, resolveShortcutSettings } from "../../shortcuts";
import { TERMINAL_OPTIONS } from "./terminalTheme";
import {
  debugXtermPane,
  paneInstances,
  setFocusedPane,
  getFocusedPane,
} from "./paneRegistry";
import { attachPaneShortcuts } from "./paneShortcuts";
import { setupPaneInstance } from "./paneSetup";
import { RELEASE_GRACE_MS, type PaneInstance } from "./types";

function createContainer(): HTMLDivElement {
  const container = document.createElement("div");
  container.style.flex = "1";
  container.style.minHeight = "0";
  container.style.overflow = "hidden";
  container.style.width = "100%";
  container.style.height = "100%";
  return container;
}

function loadShortcutSettings(inst: PaneInstance) {
  invoke<AppSettings>("get_settings")
    .then((settings) => {
      inst.shortcutsRef.current = resolveShortcutSettings(settings);
    })
    .catch(() => {
      inst.shortcutsRef.current = DEFAULT_SHORTCUTS;
    });

  listen<AppSettings>("settings-updated", (event) => {
    inst.shortcutsRef.current = resolveShortcutSettings(event.payload);
  })
    .then((fn) => {
      if (inst.cancelled) fn();
      else inst.settingsUnlisten = fn;
    })
    .catch(() => {});
}

function attachFocusTracking(inst: PaneInstance) {
  const { container, paneId } = inst;
  inst.focusInHandler = () => {
    setFocusedPane(paneId);
  };
  inst.focusOutHandler = () => {
    window.requestAnimationFrame(() => {
      if (!container.contains(document.activeElement) && getFocusedPane() === paneId) {
        setFocusedPane(null);
      }
    });
  };
  container.addEventListener("focusin", inst.focusInHandler);
  container.addEventListener("focusout", inst.focusOutHandler);
}

export function createPaneInstance(paneId: string, tmuxSession: string, resolvedGroup: string): PaneInstance {
  const container = createContainer();
  const terminal = new Terminal(TERMINAL_OPTIONS);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch (err) {
    debugXtermPane(paneId, "webgl addon unavailable, falling back to canvas/dom", { error: String(err) });
  }

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
    firstContentOutputSeen: false,
    lastSentCols: 0,
    lastSentRows: 0,
    resizeTimer: null,
  };

  loadShortcutSettings(inst);
  attachPaneShortcuts(inst);
  attachFocusTracking(inst);

  setupPaneInstance(inst).catch((err) => {
    console.error("XtermPane setup failed:", err);
  });

  return inst;
}

function teardownPaneInstance(inst: PaneInstance) {
  inst.cancelled = true;
  const { paneId, container } = inst;
  if (inst.focusInHandler) container.removeEventListener("focusin", inst.focusInHandler);
  if (inst.focusOutHandler) container.removeEventListener("focusout", inst.focusOutHandler);
  if (inst.refreshTimer) clearTimeout(inst.refreshTimer);
  if (inst.resizeTimer) clearTimeout(inst.resizeTimer);
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

export function acquirePane(paneId: string, tmuxSession: string, resolvedGroup: string): PaneInstance {
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

export function releasePane(paneId: string) {
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
