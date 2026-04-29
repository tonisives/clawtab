import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JobSortMode, ProcessProvider } from "@clawtab/shared";
import type { AppSettings } from "../../../types";
import {
  DEFAULT_SHORTCUTS,
  resolveShortcutSettings,
  type ShortcutSettings,
} from "../../../shortcuts";

export function useJobsTabSettings() {
  const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings>(DEFAULT_SHORTCUTS);
  const [defaultProvider, setDefaultProvider] = useState<ProcessProvider>("claude");
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [enabledModels, setEnabledModels] = useState<Record<string, string[]>>({});
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [jobOrder, setJobOrder] = useState<Record<string, string[]>>({});
  const [processOrder, setProcessOrder] = useState<Record<string, string[]>>(() => {
    const raw = localStorage.getItem("desktop_process_order");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  });
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<JobSortMode>("name");

  // Init shortcut settings + listen for settings-updated
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        setShortcutSettings(resolveShortcutSettings(settings));
        setDefaultProvider(settings.default_provider);
        setDefaultModel(settings.default_model ?? null);
        setEnabledModels(settings.enabled_models ?? {});
      })
      .catch(() => setShortcutSettings(DEFAULT_SHORTCUTS));

    const unlistenPromise = listen<AppSettings>("settings-updated", (event) => {
      setShortcutSettings(resolveShortcutSettings(event.payload));
      setDefaultProvider(event.payload.default_provider);
      setDefaultModel(event.payload.default_model ?? null);
      setEnabledModels(event.payload.enabled_models ?? {});
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Init group/job order from settings
  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (s.group_order && s.group_order.length > 0) {
        setGroupOrder(s.group_order);
      }
      if (s.job_order) {
        setJobOrder(s.job_order);
      }
      if (s.hidden_groups && s.hidden_groups.length > 0) {
        setHiddenGroups(new Set(s.hidden_groups));
      }
    }).catch(() => {});
  }, []);

  const persistJobOrder = useCallback((next: Record<string, string[]>) => {
    setJobOrder(next);
    invoke<AppSettings>("get_settings")
      .then((s) => invoke("set_settings", { newSettings: { ...s, job_order: next } }))
      .catch(() => {});
  }, []);

  const persistProcessOrder = useCallback((next: Record<string, string[]>) => {
    setProcessOrder(next);
    localStorage.setItem("desktop_process_order", JSON.stringify(next));
  }, []);

  const handleHideGroup = useCallback((group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.add(group);
      invoke<AppSettings>("get_settings").then((s) => {
        invoke("set_settings", { newSettings: { ...s, hidden_groups: [...next] } }).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, []);

  const handleUnhideGroup = useCallback((group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.delete(group);
      invoke<AppSettings>("get_settings").then((s) => {
        invoke("set_settings", { newSettings: { ...s, hidden_groups: [...next] } }).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, []);

  return {
    shortcutSettings,
    defaultProvider,
    defaultModel,
    enabledModels,
    groupOrder,
    jobOrder,
    processOrder,
    sortMode,
    setSortMode,
    hiddenGroups,
    persistJobOrder,
    persistProcessOrder,
    handleHideGroup,
    handleUnhideGroup,
  };
}
