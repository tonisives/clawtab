import { create } from "zustand";

type MobileHeaderTab = "jobs" | "settings";

interface MobileHeaderState {
  tab: MobileHeaderTab;
  setTab: (tab: MobileHeaderTab) => void;
  listHeaderShown: boolean;
  setListHeaderShown: (shown: boolean) => void;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  tab: "jobs",
  setTab: (tab) => set({ tab }),
  listHeaderShown: true,
  setListHeaderShown: (listHeaderShown) => set({ listHeaderShown }),
}));
