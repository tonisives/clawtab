import { create } from "zustand";
import { Platform } from "react-native";

let stored: number | null = null;
if (Platform.OS === "web" && typeof localStorage !== "undefined") {
  const v = localStorage.getItem("sidebar_width");
  if (v) stored = parseInt(v, 10);
}

const DEFAULT_WIDTH = 180;
const MIN_WIDTH = 72;
const MAX_WIDTH = 300;

type SidebarStore = {
  width: number;
  setWidth: (w: number) => void;
};

export const useSidebarStore = create<SidebarStore>((set) => ({
  width: stored ?? DEFAULT_WIDTH,
  setWidth: (w: number) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
    set({ width: clamped });
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      localStorage.setItem("sidebar_width", String(clamped));
    }
  },
}));

export { MIN_WIDTH, MAX_WIDTH };
