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
      let entry = entries.get(paneId) ?? { chunks: [], size: MAX_ENCODED_BYTES + 1 };
      // A new attach starts with ESC c, alone or followed by screen data.
      if (data.length >= 4 && atob(data.slice(0, 4)).startsWith("\x1bc")) entry = { chunks: [], size: 0 };
      // A suffix of a terminal stream is not a snapshot: it can start inside
      // an escape sequence and lacks cursor/mode state. Stop caching until a
      // new attach reset instead of replaying a truncated stream.
      entry.size += data.length;
      if (entry.size > MAX_ENCODED_BYTES) {
        entry.chunks = [];
        entry.size = MAX_ENCODED_BYTES + 1;
      } else {
        entry.chunks.push(data);
      }
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
