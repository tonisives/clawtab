import { create } from "zustand";

export type LandscapeShell =
  | { kind: "job"; slug: string }
  | { kind: "process"; paneId: string };

type LandscapeShellState = {
  focusedShell: LandscapeShell | null;
  setFocusedShell: (shell: LandscapeShell | null) => void;
};

export const useLandscapeShellStore = create<LandscapeShellState>((set) => ({
  focusedShell: null,
  setFocusedShell: (focusedShell) => set({ focusedShell }),
}));
