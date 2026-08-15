import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JobListMode, JobSortMode, ProcessProvider } from "@clawtab/shared";
import type { AppSettings } from "../../../types";
import {
  DEFAULT_SHORTCUTS,
  resolveShortcutSettings,
  type ShortcutSettings,
} from "../../../shortcuts";

const normalizePin = (key: string) => {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if (!id) return null;
  if (kind === "job") return `job:${id}`;
  if (kind === "pane" || kind === "process" || kind === "shell") return `pane:${id}`;
  return null;
};

const normalizePins = (items: string[]) =>
  [...new Set(items.map(normalizePin).filter((item): item is string => item != null))];

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
  const [pinnedItems, setPinnedItems] = useState<string[]>(() => {
    const raw = localStorage.getItem("desktop_pinned_items");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? normalizePins(parsed.filter((x): x is string => typeof x === "string"))
        : [];
    } catch {
      return [];
    }
  });
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<JobSortMode>("name");
  const [listMode, setListModeState] = useState<JobListMode>(() => {
    const value = localStorage.getItem("desktop_job_list_mode");
    return value === "tabs" || value === "latest" || value === "jobs" ? value : "tabs";
  });
  const [groupTabView, setGroupTabView] = useState<Record<string, "tabs" | "jobs">>(() => {
    const raw = localStorage.getItem("desktop_group_tab_view");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const out: Record<string, "tabs" | "jobs"> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === "tabs" || v === "jobs") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  });

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

  useEffect(() => {
    const localItems = pinnedItems;
    const migrated = localStorage.getItem("desktop_shared_pins_migrated_v1") === "1";
    const load = migrated || localItems.length === 0
      ? invoke<string[]>("get_pinned_items")
      : invoke<string[]>("merge_pinned_items", { items: localItems });
    load.then((items) => {
      const normalized = normalizePins(items);
      setPinnedItems(normalized);
      localStorage.setItem("desktop_pinned_items", JSON.stringify(normalized));
      localStorage.setItem("desktop_shared_pins_migrated_v1", "1");
    }).catch(() => {});

    const unlistenPromise = listen<string[]>("pinned-items-changed", (event) => {
      const normalized = normalizePins(event.payload);
      setPinnedItems(normalized);
      localStorage.setItem("desktop_pinned_items", JSON.stringify(normalized));
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, []); // Local pins are read once and merged into the daemon's authoritative order.

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

  const persistPinnedItems = useCallback((next: string[]) => {
    const normalized = normalizePins(next);
    setPinnedItems(normalized);
    localStorage.setItem("desktop_pinned_items", JSON.stringify(normalized));
    invoke<string[]>("merge_pinned_items", { items: normalized }).catch(() => {});
  }, []);

  const togglePin = useCallback((key: string) => {
    const normalizedKey = normalizePin(key);
    if (!normalizedKey) return;
    setPinnedItems((prev) => {
      const pinned = !prev.includes(normalizedKey);
      const next = pinned ? [...prev, normalizedKey] : prev.filter((k) => k !== normalizedKey);
      localStorage.setItem("desktop_pinned_items", JSON.stringify(next));
      invoke<string[]>("set_pinned_item", { key: normalizedKey, pinned })
        .then((items) => setPinnedItems(normalizePins(items)))
        .catch(() => setPinnedItems(prev));
      return next;
    });
  }, []);

  const setGroupTabViewFor = useCallback((group: string, view: "tabs" | "jobs") => {
    setListModeState(view);
    localStorage.setItem("desktop_job_list_mode", view);
    setGroupTabView((prev) => {
      const next = { ...prev, [group]: view };
      localStorage.setItem("desktop_group_tab_view", JSON.stringify(next));
      return next;
    });
  }, []);

  const setAllGroupTabView = useCallback((groups: string[], view: "tabs" | "jobs") => {
    setListModeState(view);
    localStorage.setItem("desktop_job_list_mode", view);
    setGroupTabView((prev) => {
      const next = { ...prev };
      for (const g of groups) next[g] = view;
      localStorage.setItem("desktop_group_tab_view", JSON.stringify(next));
      return next;
    });
  }, []);

  const setListMode = useCallback((mode: JobListMode) => {
    setListModeState(mode);
    localStorage.setItem("desktop_job_list_mode", mode);
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
    pinnedItems,
    sortMode,
    setSortMode,
    listMode,
    setListMode,
    hiddenGroups,
    persistJobOrder,
    persistProcessOrder,
    persistPinnedItems,
    togglePin,
    handleHideGroup,
    handleUnhideGroup,
    groupTabView,
    setGroupTabViewFor,
    setAllGroupTabView,
  };
}
