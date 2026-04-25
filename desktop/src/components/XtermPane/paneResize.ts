import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { PaneInstance } from "./types";

const RESIZE_DEBOUNCE_MS = 30;

export async function waitForViewportReady(
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

// Fit the terminal to its container and, if the dimensions changed since the
// last value sent to the PTY, send pty_resize. `mode` controls timing:
//   - "immediate": fire IPC synchronously. Use for split/mount transitions
//     where the user needs the sibling to reflow without delay.
//   - "debounced": coalesce rapid calls (e.g. drag-resize) into one IPC.
//
// Always reads `terminal.cols/rows` at send time — never trusts a stale cache —
// so the PTY size and xterm size cannot diverge even if multiple resizes are
// in flight.
export function fitAndSyncPty(inst: PaneInstance, mode: "immediate" | "debounced") {
  if (inst.cancelled) return;
  const { paneId, terminal, fit } = inst;
  fit.fit();
  const cols = terminal.cols;
  const rows = terminal.rows;
  if (cols < 2 || rows < 2) return;
  if (cols === inst.lastSentCols && rows === inst.lastSentRows) return;

  if (inst.resizeTimer) {
    clearTimeout(inst.resizeTimer);
    inst.resizeTimer = null;
  }

  const send = () => {
    inst.resizeTimer = null;
    if (inst.cancelled) return;
    fit.fit();
    const sendCols = terminal.cols;
    const sendRows = terminal.rows;
    if (sendCols < 2 || sendRows < 2) return;
    if (sendCols === inst.lastSentCols && sendRows === inst.lastSentRows) return;
    inst.lastSentCols = sendCols;
    inst.lastSentRows = sendRows;
    invoke("pty_resize", { paneId, cols: sendCols, rows: sendRows }).catch(() => {});
  };

  if (mode === "immediate") {
    send();
  } else {
    inst.resizeTimer = setTimeout(send, RESIZE_DEBOUNCE_MS);
  }
}

export function wireResizeObserver(inst: PaneInstance, initialCols: number, initialRows: number) {
  inst.lastSentCols = initialCols;
  inst.lastSentRows = initialRows;

  // Catch any final layout settle on the next frame after spawn.
  requestAnimationFrame(() => fitAndSyncPty(inst, "immediate"));

  inst.observer = new ResizeObserver(() => {
    fitAndSyncPty(inst, "debounced");
  });
  inst.observer.observe(inst.container);
  inst.observedEl = inst.container;
}
