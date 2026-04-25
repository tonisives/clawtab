import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaneInstance, PtySpawnResult } from "./types";
import { debugXtermPane, eventKey, isFocusPending, requestXtermPaneFocus } from "./paneRegistry";
import { waitForViewportReady, wireResizeObserver } from "./paneResize";

type SetupCtx = {
  inst: PaneInstance;
  startedAt: number;
  elapsed: () => number;
};

async function replayCachedOutput(ctx: SetupCtx) {
  const { inst, elapsed } = ctx;
  const cachedBytes = await invoke<number[]>("pty_get_cached_output", { paneId: inst.paneId }).catch(() => []);
  if (inst.cancelled) return;
  debugXtermPane(inst.paneId, "cache read", { elapsedMs: elapsed(), bytes: cachedBytes.length });
  if (cachedBytes.length > 0) {
    inst.terminal.write(new Uint8Array(cachedBytes));
    debugXtermPane(inst.paneId, "cache written", { elapsedMs: elapsed(), bytes: cachedBytes.length });
  }
}

async function wireOutputListeners(ctx: SetupCtx) {
  const { inst, elapsed } = ctx;
  const key = eventKey(inst.paneId);
  let firstOutputSeen = false;

  inst.outputUnlisten = await listen<number[]>(`pty-output-${key}`, (event) => {
    if (!firstOutputSeen) {
      firstOutputSeen = true;
      debugXtermPane(inst.paneId, "first pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
    }
    if (!inst.firstContentOutputSeen && event.payload.length > 3) {
      inst.firstContentOutputSeen = true;
      debugXtermPane(inst.paneId, "first content pty output", { elapsedMs: elapsed(), bytes: event.payload.length });
    }
    inst.terminal.write(new Uint8Array(event.payload));
  });
  debugXtermPane(inst.paneId, "output listener ready", { elapsedMs: elapsed(), event: `pty-output-${key}` });

  inst.exitUnlisten = await listen(`pty-exit-${key}`, () => {
    inst.onExitRef.current?.();
  });
}

async function spawnPtyWithRetry(
  ctx: SetupCtx,
  cols: number,
  rows: number,
): Promise<PtySpawnResult | null> {
  const { inst, elapsed } = ctx;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (inst.cancelled) return null;
    try {
      const result = await invoke<PtySpawnResult>("pty_spawn", {
        paneId: inst.paneId,
        tmuxSession: inst.tmuxSession,
        cols,
        rows,
        group: inst.resolvedGroup,
      });
      return result;
    } catch (err) {
      debugXtermPane(inst.paneId, `pty_spawn attempt ${attempt + 1} failed`, { elapsedMs: elapsed(), error: String(err) });
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  return null;
}

function startContentWatchdog(ctx: SetupCtx) {
  const { inst, elapsed } = ctx;
  inst.refreshTimer = setTimeout(() => {
    if (inst.cancelled || inst.firstContentOutputSeen) return;
    debugXtermPane(inst.paneId, "watchdog: no content at 500ms, requesting snapshot", { elapsedMs: elapsed() });
    invoke("pty_refresh_snapshot", { paneId: inst.paneId }).catch(() => {});

    inst.refreshTimer = setTimeout(async () => {
      if (inst.cancelled || inst.firstContentOutputSeen) return;
      debugXtermPane(inst.paneId, "watchdog: no content at 2s, forcing re-spawn", { elapsedMs: elapsed() });
      const gen = inst.attachGeneration;
      await invoke("pty_destroy", { paneId: inst.paneId, attachGeneration: gen }).catch(() => {});
      if (inst.cancelled || inst.firstContentOutputSeen) return;
      const retry = await invoke<PtySpawnResult>("pty_spawn", {
        paneId: inst.paneId,
        tmuxSession: inst.tmuxSession,
        cols: inst.terminal.cols,
        rows: inst.terminal.rows,
        group: inst.resolvedGroup,
      }).catch(() => null);
      if (retry) {
        inst.attachGeneration = retry.attach_generation;
      }
    }, 1500);
  }, 500);
}

const utf8Encoder = new TextEncoder();
function encodeUtf8Base64(s: string): string {
  const bytes = utf8Encoder.encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function wireInput(inst: PaneInstance) {
  let inputBuf = "";
  let inputScheduled = false;
  inst.dataDisposable = inst.terminal.onData((data) => {
    inputBuf += data;
    if (inputScheduled) return;
    inputScheduled = true;
    Promise.resolve().then(() => {
      const batch = inputBuf;
      inputBuf = "";
      inputScheduled = false;
      const encoded = encodeUtf8Base64(batch);
      invoke("pty_write", { paneId: inst.paneId, data: encoded }).catch(() => {});
    });
  });
}

async function wireDragDrop(inst: PaneInstance) {
  inst.dropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type !== "drop" || p.paths.length === 0) return;
    const rect = inst.container.getBoundingClientRect();
    const { x, y } = p.position;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const text = p.paths
      .map((fp: string) => `'${fp.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const encoded = encodeUtf8Base64(text);
    invoke("pty_write", { paneId: inst.paneId, data: encoded }).catch(() => {});
  });
}

export async function setupPaneInstance(inst: PaneInstance) {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const ctx: SetupCtx = { inst, startedAt, elapsed };
  const { paneId, tmuxSession, resolvedGroup, container, terminal, fit } = inst;

  debugXtermPane(paneId, "setup start", { tmuxSession, group: resolvedGroup });
  debugXtermPane(paneId, "terminal opened", { elapsedMs: elapsed() });

  if (isFocusPending(paneId)) requestXtermPaneFocus(paneId);

  await replayCachedOutput(ctx);
  if (inst.cancelled) return;

  const viewport = await waitForViewportReady(container, terminal, fit, () => inst.cancelled);
  if (!viewport || inst.cancelled) return;
  const { cols, rows } = viewport;
  debugXtermPane(paneId, "viewport ready", { elapsedMs: elapsed(), cols, rows });

  await wireOutputListeners(ctx);
  if (inst.cancelled) return;

  const result = await spawnPtyWithRetry(ctx, cols, rows);
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

  startContentWatchdog(ctx);

  if (result.native_cols !== cols || result.native_rows !== rows) {
    console.log(
      `[XtermPane] native ${result.native_cols}x${result.native_rows}, viewport ${cols}x${rows} - resize will trigger reflow`,
    );
  }

  wireResizeObserver(inst, cols, rows);
  wireInput(inst);
  await wireDragDrop(inst);
}
