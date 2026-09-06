const MAX_ENCODED_BYTES = 384 * 1024;

/** Memory-only terminal snapshots; credentials and terminal contents are never persisted. */
export let createTerminalCache = (initialLimit = 5) => {
  let limit = initialLimit;
  let entries = new Map<string, { chunks: string[]; size: number }>();
  let trim = () => {
    while (entries.size > limit) {
      let oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    setLimit: (value: number) => { limit = Math.max(0, Math.min(10, Math.floor(value))); trim(); },
    clear: () => entries.clear(),
    delete: (paneId: string) => entries.delete(paneId),
    append: (paneId: string, data: string) => {
      if (!limit || !data) return;
      let entry = entries.get(paneId) ?? { chunks: [], size: 0 };
      // Desktop sends ESC c followed by the current screen in a single message.
      if (data.length >= 4 && atob(data.slice(0, 4)).startsWith("\x1bc")) entry = { chunks: [], size: 0 };
      if (data.length > MAX_ENCODED_BYTES) { entries.delete(paneId); return; }
      entry.chunks.push(data);
      entry.size += data.length;
      while (entry.size > MAX_ENCODED_BYTES) entry.size -= entry.chunks.shift()?.length ?? 0;
      entries.set(paneId, entry);
      trim();
    },
    get: (paneId: string): string[] => {
      let entry = entries.get(paneId);
      if (!entry) return [];
      entries.delete(paneId);
      entries.set(paneId, entry);
      return [...entry.chunks];
    },
  };
};

export let terminalCache = createTerminalCache();
