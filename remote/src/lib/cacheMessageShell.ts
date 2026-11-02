import { encodeTerminalInput } from "@clawtab/shared";
import { terminalCache } from "./terminalCache";

// A captured notification screen can paint details while its live PTY attaches.
// The PTY's first reset replaces this preview with its authoritative screen.
export function cacheMessageShell(value: { log?: string; source?: { pane_id?: string } }) {
  const pane = value.source?.pane_id;
  if (!pane || !value.log || terminalCache.get(pane).length) return;
  terminalCache.append(pane, encodeTerminalInput("\x1bc" + value.log.replace(/\r?\n/g, "\r\n")));
}
