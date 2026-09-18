import { create } from "zustand";

type TerminalViewportState = {
  fitSafeArea: boolean;
  setFitSafeArea: (fitSafeArea: boolean) => void;
};

export let useTerminalViewportStore = create<TerminalViewportState>((set) => ({
  fitSafeArea: true,
  setFitSafeArea: (fitSafeArea) => set({ fitSafeArea }),
}));
