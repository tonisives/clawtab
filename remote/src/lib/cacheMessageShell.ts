// Shared by notification and details documents. Keep captures in memory only.
const captures = new Map<string, string>();
const limit = 10;

export function cacheMessageShell(value: { log?: string; source?: { pane_id?: string } }) {
  const pane = value.source?.pane_id;
  if (!pane || typeof value.log !== "string" || value.log.length > 384 * 1024) return;
  captures.delete(pane);
  captures.set(pane, value.log);
  if (captures.size > limit) captures.delete(captures.keys().next().value!);
}

export const getMessageShell = (pane: string) => captures.get(pane);
export const clearMessageShellCache = () => captures.clear();
export const deleteMessageShell = (pane: string) => captures.delete(pane);
