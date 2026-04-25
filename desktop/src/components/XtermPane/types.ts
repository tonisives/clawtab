import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { DEFAULT_SHORTCUTS, type ShortcutSettings } from "../../shortcuts";

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
export type PaneInstance = {
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
  // setup-time state previously held in setupPaneInstance closures
  firstContentOutputSeen: boolean;
  // Last cols/rows we sent to the PTY. Shared by the ResizeObserver and the
  // mount-time immediate sync so they don't fight or send duplicate IPCs.
  lastSentCols: number;
  lastSentRows: number;
  resizeTimer: ReturnType<typeof setTimeout> | null;
};

export interface PtySpawnResult {
  native_cols: number;
  native_rows: number;
  attach_generation: number;
}

export interface XtermPaneProps {
  paneId: string;
  tmuxSession: string;
  group?: string;
  onExit?: () => void;
}

export const RELEASE_GRACE_MS = 1500;
export const INITIAL_SHORTCUTS = DEFAULT_SHORTCUTS;
