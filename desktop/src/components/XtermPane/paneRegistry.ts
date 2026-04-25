import type { PaneInstance } from "./types";

export const paneInstances = new Map<string, PaneInstance>();

const pendingFocusPaneIds = new Set<string>();
let focusedPaneId: string | null = null;

// Tauri event names can't contain %, so sanitize pane IDs
export function eventKey(paneId: string): string {
  return paneId.replace(/%/g, "p");
}

export function debugXtermPane(paneId: string, message: string, details?: Record<string, unknown>) {
  if (details) {
    console.debug(`[XtermPane ${paneId}] ${message}`, details);
  } else {
    console.debug(`[XtermPane ${paneId}] ${message}`);
  }
}

export function isFocusPending(paneId: string): boolean {
  return pendingFocusPaneIds.has(paneId);
}

export function clearPendingFocus(paneId: string) {
  pendingFocusPaneIds.delete(paneId);
}

export function setFocusedPane(paneId: string | null) {
  focusedPaneId = paneId;
}

export function getFocusedPane(): string | null {
  return focusedPaneId;
}

export function requestXtermPaneFocus(paneId: string) {
  pendingFocusPaneIds.add(paneId);
  window.setTimeout(() => pendingFocusPaneIds.delete(paneId), 2000);
  const inst = paneInstances.get(paneId);
  if (!inst) return;
  inst.terminal.focus();
  window.requestAnimationFrame(() => inst.terminal.focus());
}
