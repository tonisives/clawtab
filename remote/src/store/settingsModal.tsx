import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

type SettingsModalCtx = {
  open: boolean;
  show: () => void;
  hide: () => void;
};

const SettingsModalContext = createContext<SettingsModalCtx>({
  open: false,
  show: () => {},
  hide: () => {},
});

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsModalContext.Provider value={{ open, show: () => setOpen(true), hide: () => setOpen(false) }}>
      {children}
    </SettingsModalContext.Provider>
  );
}

export function useSettingsModal() {
  return useContext(SettingsModalContext);
}
