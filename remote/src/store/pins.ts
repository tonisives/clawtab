import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { create } from "zustand";

import { getWsSend, nextId } from "../lib/wsRuntime";

const PINNED_ITEMS_STORAGE_KEY = "remote_pinned_items";
const SHARED_MIGRATION_KEY = "remote_shared_pins_migrated_v1";

interface PinsState {
  hydrated: boolean;
  sharedActive: boolean;
  pinnedItems: string[];
  hydrate: () => void;
  togglePin: (key: string) => void;
  applySharedSnapshot: (items: string[]) => void;
}

function normalizeKey(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (kind === "job") return `job:${id}`;
  if (kind === "pane" || kind === "process" || kind === "shell") return `pane:${id}`;
  return null;
}

function normalizeItems(items: string[]): string[] {
  return [...new Set(items.map(normalizeKey).filter((item): item is string => item != null))];
}

function parsePinnedItems(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? normalizeItems(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

function readInitialPinnedItems() {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return [];
  return parsePinnedItems(localStorage.getItem(PINNED_ITEMS_STORAGE_KEY));
}

function savePinnedItems(items: string[]) {
  const serialized = JSON.stringify(items);
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    localStorage.setItem(PINNED_ITEMS_STORAGE_KEY, serialized);
    return;
  }
  AsyncStorage.setItem(PINNED_ITEMS_STORAGE_KEY, serialized).catch(() => {});
}

async function readStorage(key: string): Promise<string | null> {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    return localStorage.getItem(key);
  }
  return AsyncStorage.getItem(key);
}

function writeStorage(key: string, value: string) {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
    return;
  }
  AsyncStorage.setItem(key, value).catch(() => {});
}

export const usePinsStore = create<PinsState>((set, get) => ({
  hydrated: Platform.OS === "web",
  sharedActive: false,
  pinnedItems: readInitialPinnedItems(),

  hydrate: () => {
    if (get().hydrated) return;
    AsyncStorage.getItem(PINNED_ITEMS_STORAGE_KEY)
      .then((raw) => {
        if (!get().sharedActive) set({ pinnedItems: parsePinnedItems(raw) });
        set({ hydrated: true });
      })
      .catch(() => set({ hydrated: true }));
  },

  togglePin: (rawKey) => {
    const key = normalizeKey(rawKey);
    if (!key) return;
    const pinned = !get().pinnedItems.includes(key);
    const next = pinned
      ? [...get().pinnedItems, key]
      : get().pinnedItems.filter((item) => item !== key);
    set({ pinnedItems: next });
    savePinnedItems(next);
    if (get().sharedActive) {
      getWsSend()?.({ type: "set_pinned_item", id: nextId(), key, pinned });
    }
  },

  applySharedSnapshot: (rawItems) => {
    const items = normalizeItems(rawItems);
    const localItems = get().sharedActive ? [] : get().pinnedItems;
    set({ sharedActive: true, pinnedItems: items, hydrated: true });
    savePinnedItems(items);

    void readStorage(SHARED_MIGRATION_KEY).then((migrated) => {
      if (migrated === "1") return;
      if (localItems.length > 0) {
        getWsSend()?.({ type: "merge_pinned_items", id: nextId(), items: localItems });
      }
      writeStorage(SHARED_MIGRATION_KEY, "1");
    });
  },
}));
