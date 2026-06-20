import { create } from "zustand";

interface JobFilterState {
  query: string;
  searchOpen: boolean;
  setQuery: (query: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
  clear: () => void;
}

export const useJobFilterStore = create<JobFilterState>((set) => ({
  query: "",
  searchOpen: false,
  setQuery: (query) => set({ query }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  clear: () => set({ query: "" }),
}));
