import { create } from "zustand";

type MobileHeaderTab = "jobs" | "settings";

interface MobileHeaderState {
  tab: MobileHeaderTab;
  setTab: (tab: MobileHeaderTab) => void;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  tab: "jobs",
  setTab: (tab) => set({ tab }),
}));
