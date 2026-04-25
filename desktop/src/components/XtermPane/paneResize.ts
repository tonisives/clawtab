import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { PaneInstance } from "./types";

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

export function wireResizeObserver(inst: PaneInstance, initialCols: number, initialRows: number) {
  const { paneId, container, terminal, fit } = inst;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let prevWidth = 0;
  let prevHeight = 0;
  let prevCols = initialCols;
  let prevRows = initialRows;

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
}
