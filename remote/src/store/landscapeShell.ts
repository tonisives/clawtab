import { create } from "zustand";

export type LandscapeShell =
  | { kind: "job"; slug: string }
  | { kind: "process"; paneId: string };

type LandscapeShellState = {
  focusedShell: LandscapeShell | null;
  fullScreenShell: LandscapeShell | null;
  pendingSidebarShell: LandscapeShell | null;
  setFocusedShell: (shell: LandscapeShell | null) => void;
  clearPendingSidebarShell: () => void;
  showSidebar: (shell: LandscapeShell) => void;
  showFullScreen: (shell: LandscapeShell) => void;
};

export const useLandscapeShellStore = create<LandscapeShellState>((set) => ({
  focusedShell: null,
  fullScreenShell: null,
  pendingSidebarShell: null,
  setFocusedShell: (focusedShell) => set((state) => {
    if (state.pendingSidebarShell === null && (
      (state.focusedShell === null && focusedShell === null)
      || (focusedShell !== null && sameLandscapeShell(state.focusedShell, focusedShell))
    )) return state;
    return { focusedShell, pendingSidebarShell: null };
  }),
  clearPendingSidebarShell: () => set({ pendingSidebarShell: null }),
  showSidebar: (focusedShell) => set({ focusedShell, fullScreenShell: null, pendingSidebarShell: focusedShell }),
  showFullScreen: (focusedShell) => set({ focusedShell, fullScreenShell: focusedShell, pendingSidebarShell: null }),
}));

export function sameLandscapeShell(a: LandscapeShell | null, b: LandscapeShell): boolean {
  if (!a) return false;
  if (a.kind === "job" && b.kind === "job") return a.slug === b.slug;
  if (a.kind === "process" && b.kind === "process") return a.paneId === b.paneId;
  return false;
}
