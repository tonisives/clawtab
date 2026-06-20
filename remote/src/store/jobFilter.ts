import { create } from "zustand";

interface JobFilterState {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
}

export const useJobFilterStore = create<JobFilterState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  clear: () => set({ query: "" }),
}));
