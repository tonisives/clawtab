import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { create } from "zustand";

const PINNED_ITEMS_STORAGE_KEY = "remote_pinned_items";

interface PinsState {
  hydrated: boolean;
  pinnedItems: string[];
  hydrate: () => void;
  togglePin: (key: string) => void;
}

function parsePinnedItems(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
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

export const usePinsStore = create<PinsState>((set, get) => ({
  hydrated: Platform.OS === "web",
  pinnedItems: readInitialPinnedItems(),

  hydrate: () => {
    if (get().hydrated) return;
    AsyncStorage.getItem(PINNED_ITEMS_STORAGE_KEY)
      .then((raw) => set({ pinnedItems: parsePinnedItems(raw), hydrated: true }))
      .catch(() => set({ hydrated: true }));
  },

  togglePin: (key) =>
    set((state) => {
      const next = state.pinnedItems.includes(key)
        ? state.pinnedItems.filter((item) => item !== key)
        : [...state.pinnedItems, key];
      savePinnedItems(next);
      return { pinnedItems: next };
    }),
}));
