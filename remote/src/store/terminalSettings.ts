import { create } from "zustand";
import * as storage from "../lib/storage";
import { terminalCache } from "../lib/terminalCache";

const KEY = "clawtab_terminal_cache_panes";
type TerminalSettings = { cachePanes: number; hydrate: () => Promise<void>; setCachePanes: (value: number) => void };
let revision = 0;
export let useTerminalSettings = create<TerminalSettings>((set) => ({
  cachePanes: 5,
  hydrate: async () => {
    let initialRevision = revision;
    try {
      let stored = await storage.getItem(KEY);
      if (stored === null || initialRevision !== revision) return;
      let value = Number(stored);
      if (![0, 5, 10].includes(value)) return;
      terminalCache.setLimit(value);
      set({ cachePanes: value });
    } catch { /* Keep the default when storage is unavailable. */ }
  },
  setCachePanes: (value) => {
    if (![0, 5, 10].includes(value)) return;
    revision += 1;
    terminalCache.setLimit(value);
    set({ cachePanes: value });
    void storage.setItem(KEY, String(value)).catch(() => {});
  },
}));
