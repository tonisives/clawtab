import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, RefreshControl, StyleSheet, Platform, type StyleProp, type ViewStyle } from "react-native";

const isWeb = Platform.OS === "web";
import type { RemoteJob, JobStatus, JobSortMode } from "../types/job";
import type { AgentModelOption, DetectedProcess, ProcessProvider, ShellPane } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { JobCard } from "./JobCard";
import { RunningJobCard } from "./RunningJobCard";
import { ProcessCard } from "./ProcessCard";
import { ShellCard } from "./ShellCard";
import { GroupAgentRow } from "./GroupAgentRow";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

const IDLE_STATUS: JobStatus = { state: "idle" };

const SORT_OPTIONS: { value: JobSortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent" },
  { value: "added", label: "Added" },
];

const GROUP_AGENT_PROVIDER_STORAGE_KEY = "clawtab_group_agent_providers";

function getStatusTimestamp(status: JobStatus | undefined): string | null {
  if (!status) return null;
  if (status.state === "running") return status.started_at;
  if (status.state === "success") return status.last_run;
  if (status.state === "failed") return status.last_run;
  return null;
}

function sortGroupKeys(
  keys: string[],
  grouped: Map<string, RemoteJob[]>,
  mode: JobSortMode,
  statuses: Record<string, JobStatus>,
): string[] {
  const sorted = [...keys];
  if (mode === "name") {
    sorted.sort((a, b) => {
      const da = a === "default" ? "General" : a;
      const db = b === "default" ? "General" : b;
      return da.localeCompare(db);
    });
  } else if (mode === "recent") {
    sorted.sort((a, b) => {
      const bestA = bestTimestamp(grouped.get(a) ?? [], statuses);
      const bestB = bestTimestamp(grouped.get(b) ?? [], statuses);
      if (bestA && bestB) return bestB.localeCompare(bestA);
      if (bestA) return -1;
      if (bestB) return 1;
      return a.localeCompare(b);
    });
  } else if (mode === "added") {
    sorted.sort((a, b) => {
      const bestA = newestAdded(grouped.get(a) ?? []);
      const bestB = newestAdded(grouped.get(b) ?? []);
      if (bestA && bestB) return bestB.localeCompare(bestA);
      if (bestA) return -1;
      if (bestB) return 1;
      return a.localeCompare(b);
    });
  }
  return sorted;
}

function bestTimestamp(jobs: RemoteJob[], statuses: Record<string, JobStatus>): string | null {
  let best: string | null = null;
  for (const job of jobs) {
    const ts = getStatusTimestamp(statuses[job.slug]);
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

function newestAdded(jobs: RemoteJob[]): string | null {
  let best: string | null = null;
  for (const job of jobs) {
    const ts = job.added_at;
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

export interface JobListViewProps {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: DetectedProcess[];
  shellPanes?: ShellPane[];
  collapsedGroups: Set<string>;
  onToggleGroup: (group: string) => void;
  groupOrder?: string[];
  jobOrder?: Record<string, string[]>;
  processOrder?: Record<string, string[]>;
  onRefresh?: () => void;
  // Sorting
  sortMode?: JobSortMode;
  onSortChange?: (mode: JobSortMode) => void;
  // Navigation
  onSelectJob?: (job: RemoteJob) => void;
  onSelectProcess?: (process: DetectedProcess) => void;
  onSelectShell?: (shell: ShellPane) => void;
  // Map of slug/pane_id -> color hex for highlighted items (supports multi-selection)
  selectedItems?: Map<string, string> | null;
  // The key of the focused item (brighter border); unfocused selected items are faded
  focusedItemKey?: string | null;
  // Single selection (backward compat with desktop) - uses accent color
  selectedSlug?: string | null;
  // Agent
  onRunAgent?: (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) => void;
  getAgentProviders?: () => Promise<ProcessProvider[]>;
  defaultAgentProvider?: ProcessProvider;
  agentModelOptions?: AgentModelOption[];
  defaultAgentModel?: string | null;
  // Desktop-only slots
  onAddJob?: (group: string, folderPath?: string) => void;
  onEditJob?: (job: RemoteJob) => void;
  onOpenJob?: (job: RemoteJob) => void;
  // Hidden groups
  hiddenGroups?: Set<string>;
  onHideGroup?: (group: string) => void;
  onUnhideGroup?: (group: string) => void;
  // Header content (for banners, notifications, etc.)
  headerContent?: React.ReactNode;
  // Show empty state
  showEmpty?: boolean;
  emptyMessage?: string;
  // Extra style for scroll content container
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Restore scroll position (web only)
  initialScrollOffset?: number;
  // Report scroll position changes (web only)
  onScrollOffsetChange?: (offset: number) => void;
  // Scroll a specific slug into view (bumped counter to trigger re-scroll)
  scrollToSlug?: string | null;
  // Stop job/process from sidebar
  onStopJob?: (slug: string) => void;
  onStopProcess?: (paneId: string) => void;
  onRenameProcess?: (process: DetectedProcess) => void;
  onSaveProcessName?: (process: DetectedProcess, name: string) => void;
  onStopShell?: (paneId: string) => void;
  onRenameShell?: (shell: ShellPane) => void;
  // Auto-yes pane IDs (for yellow indicator)
  autoYesPaneIds?: Set<string>;
  // Custom card renderers (for drag-and-drop wrappers)
  renderJobCard?: (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: boolean | string; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string; defaultAgentProvider?: ProcessProvider }) => React.ReactNode;
  renderProcessCard?: (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: boolean | string; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string; startRenameSignal?: number; onRenameDraftChange?: (value: string | null) => void; onRenameStateChange?: (editing: boolean) => void }) => React.ReactNode;
  renderShellCard?: (props: { shell: ShellPane; onPress?: () => void; selected?: boolean | string; onStop?: () => void; onRename?: () => void }) => React.ReactNode;
  wrapJobGroup?: (group: string, jobSlugs: string[], children: React.ReactNode) => React.ReactNode;
  wrapProcessGroup?: (group: string, processPaneIds: string[], children: React.ReactNode) => React.ReactNode;
  // Disable scrolling (e.g. during drag-and-drop)
  scrollEnabled?: boolean;
  // Slugs currently being stopped (for "Stopping..." display in sidebar)
  stoppingSlugs?: Set<string>;
  // Visible selectable items in rendered sidebar order
  onSelectableItemsChange?: (items: SidebarSelectableItem[]) => void;
  // Ref to focus the sidebar container (desktop only)
  sidebarFocusRef?: React.MutableRefObject<{ focus: () => void } | null>;
  focusAgentWorkDir?: string | null;
  focusAgentSignal?: number;
  renameProcessPaneId?: string | null;
  renameProcessSignal?: number;
  onProcessRenameDraftChange?: (paneId: string, value: string | null) => void;
  onProcessRenameStateChange?: (paneId: string, editing: boolean) => void;
}

type ListItem =
  | { kind: "header"; group: string; displayGroup: string; folderPath?: string }
  | { kind: "job"; job: RemoteJob; idx: number }
  | { kind: "process"; process: DetectedProcess; inGroup?: boolean }
  | { kind: "shell"; shell: ShellPane }
  | { kind: "group-agent"; workDir: string }
  | { kind: "hidden-section" }
  | { kind: "hidden-header"; group: string; displayGroup: string };

export type SidebarSelectableItem =
  | { kind: "job"; key: string; job: RemoteJob }
  | { kind: "process"; key: string; process: DetectedProcess }
  | { kind: "shell"; key: string; shell: ShellPane };

function areSelectableItemsEqual(
  left: SidebarSelectableItem[],
  right: SidebarSelectableItem[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].kind !== right[i].kind || left[i].key !== right[i].key) {
      return false;
    }
  }
  return true;
}

export function JobListView({
  jobs,
  statuses,
  detectedProcesses,
  shellPanes = [],
  collapsedGroups,
  onToggleGroup,
  groupOrder: _groupOrder = [],
  jobOrder = {},
  processOrder = {},
  onRefresh,
  sortMode = "name",
  onSortChange,
  onSelectJob,
  onSelectProcess,
  onSelectShell,
  selectedItems,
  focusedItemKey,
  selectedSlug,
  onRunAgent,
  getAgentProviders,
  defaultAgentProvider = "claude",
  agentModelOptions = [],
  defaultAgentModel,
  onAddJob,
  hiddenGroups,
  onHideGroup,
  onUnhideGroup,
  headerContent,
  showEmpty = true,
  emptyMessage = "No jobs found.",
  contentContainerStyle,
  initialScrollOffset,
  onScrollOffsetChange,
  scrollToSlug,
  onStopJob,
  onStopProcess,
  onRenameProcess,
  onSaveProcessName,
  onStopShell,
  onRenameShell,
  autoYesPaneIds,
  renderJobCard: customRenderJobCard,
  renderProcessCard: customRenderProcessCard,
  renderShellCard: customRenderShellCard,
  wrapJobGroup,
  wrapProcessGroup,
  scrollEnabled = true,
  stoppingSlugs: stoppingSlugsExternal,
  onSelectableItemsChange,
  sidebarFocusRef,
  focusAgentWorkDir,
  focusAgentSignal,
  renameProcessPaneId,
  renameProcessSignal,
  onProcessRenameDraftChange,
  onProcessRenameStateChange,
}: JobListViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const searchRef = useRef<TextInput>(null);
  const containerRef = useRef<View>(null);

  useEffect(() => {
    if (sidebarFocusRef) {
      sidebarFocusRef.current = {
        focus: () => {
          const el = (containerRef.current as any) as HTMLElement | undefined;
          el?.focus?.();
        },
      };
    }
    return () => { if (sidebarFocusRef) sidebarFocusRef.current = null; };
  }, [sidebarFocusRef]);
  const [sortOpen, setSortOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedJobPanes, setCollapsedJobPanes] = useState<Set<string>>(() => new Set());
  const [agentProviders, setAgentProviders] = useState<ProcessProvider[]>([]);
  const [groupAgentProviders, setGroupAgentProviders] = useState<Record<string, ProcessProvider>>(() => {
    if (!isWeb || typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(GROUP_AGENT_PROVIDER_STORAGE_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, ProcessProvider>;
    } catch {
      return {};
    }
  });
  const [groupAgentModels, setGroupAgentModels] = useState<Record<string, string | null>>({});
  const [groupMenu, setGroupMenu] = useState<{ group: string; folderPath?: string } | null>(null);
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null);
  const groupMenuDropdownRef = useRef<View>(null);
  const groupMenuTriggerRef = useRef<any>(null);
  const sortTriggerRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    if (!getAgentProviders) return;
    getAgentProviders()
      .then((providers) => {
        if (!cancelled) setAgentProviders(providers);
      })
      .catch(() => {
        if (!cancelled) setAgentProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [getAgentProviders]);

  useEffect(() => {
    if (!isWeb || typeof localStorage === "undefined") return;
    localStorage.setItem(GROUP_AGENT_PROVIDER_STORAGE_KEY, JSON.stringify(groupAgentProviders));
  }, [groupAgentProviders]);

  const resolvedAgentProviders = useMemo(() => {
    const next = agentProviders.includes(defaultAgentProvider)
      ? agentProviders
      : [defaultAgentProvider, ...agentProviders];
    return next.filter((provider, index) => next.indexOf(provider) === index);
  }, [agentProviders, defaultAgentProvider]);

  const resolveGroupAgentProvider = useCallback((workDir: string) => {
    const stored = groupAgentProviders[workDir];
    if (stored && resolvedAgentProviders.includes(stored)) return stored;
    return defaultAgentProvider;
  }, [defaultAgentProvider, groupAgentProviders, resolvedAgentProviders]);

  const handleSetGroupAgentProvider = useCallback((workDir: string, provider: ProcessProvider) => {
    setGroupAgentProviders((prev) => {
      if (prev[workDir] === provider) return prev;
      return { ...prev, [workDir]: provider };
    });
  }, []);

  const handleSetGroupAgentModel = useCallback((workDir: string, provider: ProcessProvider, modelId: string | null) => {
    setGroupAgentProviders((prev) => {
      if (prev[workDir] === provider) return prev;
      return { ...prev, [workDir]: provider };
    });
    setGroupAgentModels((prev) => {
      if (prev[workDir] === modelId) return prev;
      return { ...prev, [workDir]: modelId };
    });
  }, []);

  // Keyboard shortcut: Cmd+F (desktop) or / (web) to focus search
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const getContainer = () => (containerRef.current as any) as HTMLElement | undefined;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "/") {
        const el = e.target as HTMLElement;
        const tag = el?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
        const container = getContainer();
        if (!container) return;
        const active = document.activeElement as HTMLElement | null;
        const sidebarFocused = active === document.body || (active && container.contains(active));
        if (!sidebarFocused) return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // (outside-click for group menu handled by PopupMenu)

  const query = searchQuery.toLowerCase().trim();

  const grouped = useMemo(() => {
    const map = new Map<string, RemoteJob[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      const displayGroup = group === "default" ? "general" : group.toLowerCase();
      if (query) {
        const nameMatch = job.name.toLowerCase().includes(query);
        const groupMatch = displayGroup.includes(query);
        if (!nameMatch && !groupMatch) continue;
      }
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [group, groupJobs] of map) {
        const manualOrder = jobOrder[group] ?? [];
        const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
        groupJobs.sort((a, b) => {
          const aIndex = manualIndex.get(a.slug);
          const bIndex = manualIndex.get(b.slug);
          if (aIndex != null && bIndex != null) return aIndex - bIndex;
          if (aIndex != null) return -1;
          if (bIndex != null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }
    return map;
  }, [jobOrder, jobs, query, sortMode]);

  const sortedGroupKeys = useMemo(
    () => sortGroupKeys([...grouped.keys()], grouped, sortMode, statuses),
    [grouped, sortMode, statuses],
  );

  const matchedProcessesByGroup = useMemo(() => {
    const map = new Map<string, DetectedProcess[]>();
    const paneToRunningJobSlug = new Map<string, string>();
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state === "running" && status.pane_id) {
        paneToRunningJobSlug.set(status.pane_id, job.slug);
      }
    }
    for (const proc of detectedProcesses) {
      if (paneToRunningJobSlug.has(proc.pane_id)) continue;
      if (proc.matched_group) {
        const list = map.get(proc.matched_group) ?? [];
        list.push(proc);
        map.set(proc.matched_group, list);
      }
    }
    for (const [group, list] of map) {
      const manualOrder = processOrder[group] ?? [];
      const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
      list.sort((a, b) => {
        const aIndex = manualIndex.get(a.pane_id);
        const bIndex = manualIndex.get(b.pane_id);
        if (aIndex != null && bIndex != null) return aIndex - bIndex;
        if (aIndex != null) return -1;
        if (bIndex != null) return 1;
        return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
      });
    }
    return map;
  }, [detectedProcesses, jobs, processOrder, statuses]);

  const matchedProcessesByJob = useMemo(() => {
    const map = new Map<string, DetectedProcess[]>();
    const paneToRunningJobSlug = new Map<string, string>();
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state === "running" && status.pane_id) {
        paneToRunningJobSlug.set(status.pane_id, job.slug);
      }
    }
    for (const proc of detectedProcesses) {
      const matchedJobSlug = paneToRunningJobSlug.get(proc.pane_id);
      if (!matchedJobSlug) continue;
      const list = map.get(matchedJobSlug) ?? [];
      list.push(proc);
      map.set(matchedJobSlug, list);
    }
    for (const [slug, list] of map) {
      const job = jobs.find((item) => item.slug === slug);
      const manualOrder = job ? processOrder[job.group || "default"] ?? [] : [];
      const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
      list.sort((a, b) => {
        const aIndex = manualIndex.get(a.pane_id);
        const bIndex = manualIndex.get(b.pane_id);
        if (aIndex != null && bIndex != null) return aIndex - bIndex;
        if (aIndex != null) return -1;
        if (bIndex != null) return 1;
        return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
      });
    }
    return map;
  }, [detectedProcesses, jobs, processOrder, statuses]);

  const matchedShellsByGroup = useMemo(() => {
    const map = new Map<string, ShellPane[]>();
    for (const shell of shellPanes) {
      if (!shell.matched_group) continue;
      const list = map.get(shell.matched_group) ?? [];
      list.push(shell);
      map.set(shell.matched_group, list);
    }
    return map;
  }, [shellPanes]);

  const unmatchedProcesses = useMemo(
    () => detectedProcesses.filter((p) => {
      const matchedRunningJob = jobs.some((job) => {
        const status = statuses[job.slug];
        return status?.state === "running" && status.pane_id === p.pane_id;
      });
      if (matchedRunningJob) return false;
      if (p.matched_group) return false;
      if (!query) return true;
      const folderName = p.cwd.split("/").filter(Boolean).pop() ?? "";
      return folderName.toLowerCase().includes(query) || p.cwd.toLowerCase().includes(query);
    }),
    [detectedProcesses, jobs, query, statuses],
  );

  const items = useMemo(() => {
    const result: ListItem[] = [];

    // Build detected-process folder groups and ungrouped list
    const detFolderGroups: [string, DetectedProcess[]][] = [];
    const detUngrouped: DetectedProcess[] = [];
    if (unmatchedProcesses.length > 0) {
      const byFolder = new Map<string, DetectedProcess[]>();
      for (const proc of unmatchedProcesses) {
        const list = byFolder.get(proc.cwd) ?? [];
        list.push(proc);
        byFolder.set(proc.cwd, list);
      }
      for (const [folder, procs] of byFolder) {
        if (procs.length >= 2 && folder) {
          detFolderGroups.push([folder, procs]);
        } else {
          detUngrouped.push(...procs);
        }
      }
    }

    // Unified group entries for interleaved sorting
    type GroupEntry =
      | { type: "job"; group: string; displayGroup: string; folderPath?: string; jobs: RemoteJob[]; procs: DetectedProcess[] }
      | { type: "detected"; groupKey: string; displayGroup: string; folderPath: string; procs: DetectedProcess[] }
      | { type: "ungrouped"; procs: DetectedProcess[] };

    const allGroups: GroupEntry[] = [];

    for (const group of sortedGroupKeys) {
      const gJobs = grouped.get(group) ?? [];
      const fp = gJobs[0]?.folder_path ?? gJobs[0]?.work_dir;
      const displayGroup = group === "default"
        ? (fp ? fp.split("/").filter(Boolean).pop() ?? "General" : "General")
        : group;
      allGroups.push({
        type: "job",
        group,
        displayGroup,
        folderPath: fp,
        jobs: gJobs,
        procs: matchedProcessesByGroup.get(group) ?? [],
      });
    }

    for (const [folder, procs] of detFolderGroups) {
      // Merge into existing job group if one shares this folder path
      const existing = allGroups.find(
        (g) => g.type === "job" && g.folderPath === folder,
      );
      if (existing && existing.type === "job") {
        existing.procs = [...existing.procs, ...procs];
      } else {
        const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
        allGroups.push({
          type: "detected",
          groupKey: `_det_${folder}`,
          displayGroup: folderName,
          folderPath: folder,
          procs,
        });
      }
    }

    // When sorting by name, interleave all groups alphabetically
    if (sortMode === "name") {
      allGroups.sort((a, b) => {
        const da = "displayGroup" in a ? a.displayGroup : "";
        const db = "displayGroup" in b ? b.displayGroup : "";
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }

    if (detUngrouped.length > 0) {
      allGroups.push({ type: "ungrouped", procs: detUngrouped });
    }

    // Split into visible and hidden groups
    const isGroupHidden = (entry: GroupEntry) => {
      if (!hiddenGroups?.size) return false;
      const name = "displayGroup" in entry ? entry.displayGroup : "";
      return hiddenGroups.has(name);
    };

    const visibleGroups = allGroups.filter((e) => !isGroupHidden(e));
    const hiddenEntries = allGroups.filter((e) => isGroupHidden(e));
    const hasMultipleGroups = visibleGroups.length > 1;

    for (const entry of visibleGroups) {
      if (entry.type === "job") {
        if (hasMultipleGroups || result.length > 0 || query) {
          result.push({ kind: "header", group: entry.displayGroup, displayGroup: entry.displayGroup, folderPath: entry.folderPath });
        }
        if (!collapsedGroups.has(entry.displayGroup)) {
          let jobIdx = 0;
          for (const job of entry.jobs) {
            result.push({ kind: "job", job, idx: jobIdx++ });
          }
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc, inGroup: true });
          }
          for (const shell of matchedShellsByGroup.get(entry.group) ?? []) {
            result.push({ kind: "shell", shell });
          }
          if (onRunAgent) {
            const groupWorkDir = entry.jobs[0]?.folder_path ?? entry.jobs[0]?.work_dir;
            if (groupWorkDir) {
              result.push({ kind: "group-agent", workDir: groupWorkDir });
            }
          }
        }
      } else if (entry.type === "detected") {
        result.push({ kind: "header", group: entry.groupKey, displayGroup: entry.displayGroup, folderPath: entry.folderPath });
        if (!collapsedGroups.has(entry.groupKey)) {
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc });
          }
          if (onRunAgent && entry.folderPath) {
            result.push({ kind: "group-agent", workDir: entry.folderPath });
          }
        }
      } else {
        result.push({ kind: "header", group: "Detected", displayGroup: "Detected" });
        if (!collapsedGroups.has("Detected")) {
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc });
          }
        }
      }
    }

    // Add hidden groups section at the bottom
    if (hiddenEntries.length > 0) {
      result.push({ kind: "hidden-section" });
      for (const entry of hiddenEntries) {
        const displayGroup = "displayGroup" in entry ? entry.displayGroup : "Detected";
        const group = entry.type === "job" ? entry.displayGroup : entry.type === "detected" ? entry.groupKey : "Detected";
        result.push({ kind: "hidden-header", group, displayGroup });
      }
    }

    const unmatchedShells: ShellPane[] = [];
    for (const shell of shellPanes) {
      if (!shell.matched_group || !allGroups.some((entry) => entry.type === "job" && entry.group === shell.matched_group)) {
        unmatchedShells.push(shell);
      }
    }

    if (unmatchedShells.length > 0) {
      result.push({ kind: "header", group: "Shells", displayGroup: "Shells" });
      if (!collapsedGroups.has("Shells")) {
        for (const shell of unmatchedShells) {
          result.push({ kind: "shell", shell });
        }
      }
    }

    return result;
  }, [grouped, sortedGroupKeys, collapsedGroups, hiddenGroups, matchedProcessesByGroup, matchedShellsByGroup, unmatchedProcesses, onRunAgent, shellPanes]);

  const selectableItems = useMemo((): SidebarSelectableItem[] => (
    items.flatMap((item): SidebarSelectableItem[] => {
      if (item.kind === "job") {
        return [
          { kind: "job", key: item.job.slug, job: item.job },
          ...(matchedProcessesByJob.get(item.job.slug) ?? []).map((process) => (
            { kind: "process" as const, key: process.pane_id, process }
          )),
        ];
      }
      if (item.kind === "process") return [{ kind: "process", key: item.process.pane_id, process: item.process }];
      if (item.kind === "shell") return [{ kind: "shell", key: `_term_${item.shell.pane_id}`, shell: item.shell }];
      return [];
    })
  ), [items, matchedProcessesByJob]);

  const lastSelectableItemsRef = useRef<SidebarSelectableItem[]>([]);
  useEffect(() => {
    if (areSelectableItemsEqual(lastSelectableItemsRef.current, selectableItems)) {
      return;
    }
    lastSelectableItemsRef.current = selectableItems;
    onSelectableItemsChange?.(selectableItems);
  }, [onSelectableItemsChange, selectableItems]);

  const handleRefresh = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);

  const toggleJobPanes = useCallback((slug: string) => {
    setCollapsedJobPanes((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }, []);

  const renderJobItem = (item: Extract<ListItem, { kind: "job" }>, key: string, index: number) => {
    const status = statuses[item.job.slug] ?? IDLE_STATUS;
    const pressHandler = onSelectJob ? () => onSelectJob(item.job) : undefined;
    const rawJobColor = selectedItems?.get(item.job.slug);
    const isJobFocused = !focusedItemKey || focusedItemKey === item.job.slug;
    const isSelected: boolean | string = rawJobColor
      ? (isJobFocused ? rawJobColor : rawJobColor + "66")
      : (selectedSlug === item.job.slug);
    const isRunning = status.state === "running";
    const jobPaneId = isRunning ? (status as { pane_id?: string }).pane_id : undefined;
    const jobAutoYesActive = jobPaneId ? autoYesPaneIds?.has(jobPaneId) ?? false : false;
    const isStopping = stoppingSlugsExternal?.has(item.job.slug) ?? false;
    const jobOnStop = isRunning && !isStopping && onStopJob ? () => onStopJob(item.job.slug) : undefined;
    const marginTop = index > 0 ? spacing.sm : undefined;
    const dimmed = item.idx % 2 === 1;
    const childProcesses = matchedProcessesByJob.get(item.job.slug) ?? [];
    const hasChildProcesses = childProcesses.length > 0;
    const childProcessesExpanded = hasChildProcesses && !collapsedJobPanes.has(item.job.slug);
    const renderChildProcess = (process: DetectedProcess, offset: number) => {
      const terminalKey = `_term_${process.pane_id}`;
      const rawColor = selectedItems?.get(process.pane_id) ?? selectedItems?.get(terminalKey);
      const isFocused = !focusedItemKey || focusedItemKey === process.pane_id || focusedItemKey === terminalKey;
      const isProcessSelected: boolean | string = rawColor
        ? (isFocused ? rawColor : rawColor + "66")
        : (selectedSlug === process.pane_id);
      const processOnStop = onStopProcess ? () => onStopProcess(process.pane_id) : undefined;
      const processOnRename = onRenameProcess ? () => onRenameProcess(process) : undefined;
      const processOnSaveName = onSaveProcessName ? (name: string) => onSaveProcessName(process, name) : undefined;
      return (
        <View key={`job_${item.job.slug}_pane_${process.pane_id}`} style={[styles.jobChildProcess, offset > 0 ? { marginTop: spacing.xs } : undefined]}>
          {customRenderProcessCard
            ? customRenderProcessCard({
              process,
              sortGroup: `job:${item.job.slug}`,
              onPress: onSelectProcess ? () => onSelectProcess(process) : undefined,
              inGroup: true,
              selected: isProcessSelected,
              onStop: processOnStop,
              onRename: processOnRename,
              onSaveName: processOnSaveName,
              autoYesActive: autoYesPaneIds?.has(process.pane_id) ?? false,
              dataProcessId: process.pane_id,
              startRenameSignal: renameProcessPaneId === process.pane_id ? renameProcessSignal : undefined,
              onRenameDraftChange: (value: string | null) => onProcessRenameDraftChange?.(process.pane_id, value),
              onRenameStateChange: (editing: boolean) => onProcessRenameStateChange?.(process.pane_id, editing),
            })
            : (
              <ProcessCard
                process={process}
                onPress={onSelectProcess ? () => onSelectProcess(process) : undefined}
                inGroup
                selected={isProcessSelected}
                onStop={processOnStop}
                onRename={processOnRename}
                onSaveName={processOnSaveName}
                autoYesActive={autoYesPaneIds?.has(process.pane_id) ?? false}
                startRenameSignal={renameProcessPaneId === process.pane_id ? renameProcessSignal : undefined}
                onRenameDraftChange={(value) => onProcessRenameDraftChange?.(process.pane_id, value)}
                onRenameStateChange={(editing) => onProcessRenameStateChange?.(process.pane_id, editing)}
              />
            )}
        </View>
      );
    };
    const expandToggle = hasChildProcesses ? (
      <TouchableOpacity
        onPress={(e: any) => {
          e.stopPropagation?.();
          toggleJobPanes(item.job.slug);
        }}
        style={styles.jobPaneToggle}
        activeOpacity={0.6}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.jobPaneToggleText}>
          {childProcessesExpanded ? "\u25BE" : "\u25B8"}
        </Text>
      </TouchableOpacity>
    ) : null;
    return (
      <View key={key}>
        <View style={styles.jobWithPaneToggle}>
          {customRenderJobCard ? (
            customRenderJobCard({ job: item.job, group: item.job.group || "default", indexInGroup: item.idx, status, onPress: pressHandler, selected: isSelected, onStop: jobOnStop, autoYesActive: jobAutoYesActive, stopping: isStopping, marginTop, dimmed, dataJobSlug: item.job.slug, defaultAgentProvider })
          ) : (
            <View
              {...(Platform.OS === "web" ? { dataSet: { jobSlug: item.job.slug } } : {})}
              style={[
                dimmed ? { opacity: 0.85 } : undefined,
                marginTop != null ? { marginTop } : undefined,
              ]}
            >
              {status.state === "running" ? (
                <RunningJobCard
                  job={item.job}
                  status={status}
                  onPress={pressHandler}
                  selected={isSelected}
                  onStop={jobOnStop}
                  autoYesActive={jobAutoYesActive}
                  stopping={isStopping}
                  defaultAgentProvider={defaultAgentProvider}
                />
              ) : (
                <JobCard
                  job={item.job}
                  status={status}
                  onPress={pressHandler}
                  selected={isSelected}
                  defaultAgentProvider={defaultAgentProvider}
                />
              )}
            </View>
          )}
          {expandToggle}
        </View>
        {childProcessesExpanded ? (
          <View style={styles.jobChildProcesses}>
            {childProcesses.map((process, offset) => renderChildProcess(process, offset))}
          </View>
        ) : null}
      </View>
    );
  };

  const renderProcessItem = (item: Extract<ListItem, { kind: "process" }>, key: string, index: number) => {
    const pressHandler = onSelectProcess ? () => onSelectProcess(item.process) : undefined;
    const terminalKey = `_term_${item.process.pane_id}`;
    const rawColor = selectedItems?.get(item.process.pane_id) ?? selectedItems?.get(terminalKey);
    const isFocused = !focusedItemKey || focusedItemKey === item.process.pane_id || focusedItemKey === terminalKey;
    const isSelected: boolean | string = rawColor
      ? (isFocused ? rawColor : rawColor + "66")
      : (selectedSlug === item.process.pane_id);
    const procAutoYesActive = autoYesPaneIds?.has(item.process.pane_id) ?? false;
    const procOnStop = onStopProcess ? () => onStopProcess(item.process.pane_id) : undefined;
    const procOnRename = onRenameProcess ? () => onRenameProcess(item.process) : undefined;
    const procOnSaveName = onSaveProcessName ? (name: string) => onSaveProcessName(item.process, name) : undefined;
    const marginTop = index > 0 ? spacing.sm : undefined;
    const sortGroup = item.process.matched_group ?? `cwd:${item.process.cwd}`;
    return customRenderProcessCard ? (
      <View key={key}>
        {customRenderProcessCard({ process: item.process, sortGroup, onPress: pressHandler, inGroup: item.inGroup, selected: isSelected, onStop: procOnStop, onRename: procOnRename, onSaveName: procOnSaveName, autoYesActive: procAutoYesActive, marginTop, dataProcessId: item.process.pane_id, startRenameSignal: renameProcessPaneId === item.process.pane_id ? renameProcessSignal : undefined, onRenameDraftChange: (value: string | null) => onProcessRenameDraftChange?.(item.process.pane_id, value), onRenameStateChange: (editing: boolean) => onProcessRenameStateChange?.(item.process.pane_id, editing) })}
      </View>
    ) : (
      <View key={key} {...(Platform.OS === "web" ? { dataSet: { processId: item.process.pane_id } } : {})} style={marginTop != null ? { marginTop } : undefined}>
        <ProcessCard process={item.process} onPress={pressHandler} inGroup={item.inGroup} selected={isSelected} onStop={procOnStop} onRename={procOnRename} onSaveName={procOnSaveName} autoYesActive={procAutoYesActive} startRenameSignal={renameProcessPaneId === item.process.pane_id ? renameProcessSignal : undefined} onRenameDraftChange={(value) => onProcessRenameDraftChange?.(item.process.pane_id, value)} onRenameStateChange={(editing) => onProcessRenameStateChange?.(item.process.pane_id, editing)} />
      </View>
    );
  };

  const renderItemsWithSortableGroups = () => {
    if (items.length === 0 && (showEmpty || query)) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{query ? "No matches" : "No jobs"}</Text>
          <Text style={styles.emptyText}>{query ? `No jobs or groups matching "${searchQuery}"` : emptyMessage}</Text>
        </View>
      );
    }
    const rendered: React.ReactNode[] = [];
    let index = 0;
    while (index < items.length) {
      const item = items[index];
      if (item.kind === "job") {
        const jobItems: Extract<ListItem, { kind: "job" }>[] = [];
        const startIndex = index;
        while (index < items.length && items[index]?.kind === "job") {
          jobItems.push(items[index] as Extract<ListItem, { kind: "job" }>);
          index += 1;
        }
        const children = jobItems.map((jobItem, offset) => {
          const key = `j_${jobItem.job.slug || jobItem.job.name}`;
          return renderJobItem(jobItem, key, startIndex + offset);
        });
        const group = jobItems[0]?.job.group || "default";
        const jobSlugs = jobItems.map((jobItem) => jobItem.job.slug);
        rendered.push(
          wrapJobGroup ? wrapJobGroup(group, jobSlugs, children) : children,
        );
        continue;
      }
      if (item.kind === "process") {
        const processItems: Extract<ListItem, { kind: "process" }>[] = [];
        const startIndex = index;
        while (index < items.length && items[index]?.kind === "process") {
          processItems.push(items[index] as Extract<ListItem, { kind: "process" }>);
          index += 1;
        }
        const children = processItems.map((processItem, offset) => {
          const key = `p_${processItem.process.pane_id}`;
          return renderProcessItem(processItem, key, startIndex + offset);
        });
        const group = processItems[0]?.process.matched_group ?? `cwd:${processItems[0]?.process.cwd ?? ""}`;
        const processPaneIds = processItems.map((processItem) => processItem.process.pane_id);
        rendered.push(
          wrapProcessGroup ? wrapProcessGroup(group, processPaneIds, children) : children,
        );
        continue;
      }
      const key =
        item.kind === "header"
          ? `h_${item.group}`
          : item.kind === "shell"
              ? `s_${item.shell.pane_id}`
            : item.kind === "group-agent"
              ? `ga_${item.workDir}`
              : item.kind === "hidden-section"
                ? "hidden_section"
                : `hh_${item.group}`;
      rendered.push(
        (() => {
              if (item.kind === "header") {
                const isCollapsed = collapsedGroups.has(item.group);
                const allowGroupMenu = item.group !== "Shells" && (onAddJob || onHideGroup);
                return (
                  <View key={key} style={index > 0 ? { marginTop: spacing.sm } : undefined}>
                    <TouchableOpacity
                      onPress={() => onToggleGroup(item.group)}
                      style={styles.groupHeaderRow}
                      activeOpacity={0.6}
                    >
                      <Text style={styles.groupHeaderArrow}>
                        {isCollapsed ? "\u25B6" : "\u25BC"}
                      </Text>
                      <Text style={styles.groupHeader}>{item.displayGroup}</Text>
                      {item.folderPath && (
                        <Text style={styles.groupFolderPath} numberOfLines={1}>
                          {item.folderPath.replace(/^\/Users\/[^/]+/, "~")}
                        </Text>
                      )}
                      {allowGroupMenu && (
                        <TouchableOpacity
                          ref={(r: any) => { if (groupMenu?.group === item.group) groupMenuTriggerRef.current = r; }}
                          onPress={(e: any) => {
                            e.stopPropagation();
                            if (groupMenu?.group === item.group) {
                              setGroupMenu(null);
                              return;
                            }
                            if (isWeb) {
                              const node = e?.currentTarget ?? e?.target;
                              groupMenuTriggerRef.current = node;
                              if (node?.getBoundingClientRect) {
                                const rect = node.getBoundingClientRect();
                                setGroupMenuPos({ top: rect.bottom + 4, left: rect.right });
                              }
                            }
                            setGroupMenu({ group: item.group, folderPath: item.folderPath });
                          }}
                          style={styles.addJobBtn}
                          activeOpacity={0.6}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={styles.addJobBtnText}>{"\u2026"}</Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  </View>
                );
              }

              if (item.kind === "shell") {
                const pressHandler = onSelectShell ? () => onSelectShell(item.shell) : undefined;
                const keyId = `_term_${item.shell.pane_id}`;
                const rawColor = selectedItems?.get(keyId);
                const isFocused = !focusedItemKey || focusedItemKey === keyId;
                const isSelected: boolean | string = rawColor
                  ? (isFocused ? rawColor : rawColor + "66")
                  : (selectedSlug === keyId);
                const shellOnStop = onStopShell ? () => onStopShell(item.shell.pane_id) : undefined;
                const shellOnRename = onRenameShell ? () => onRenameShell(item.shell) : undefined;
                return (
                  <View key={key} {...(Platform.OS === "web" ? { dataSet: { shellId: item.shell.pane_id } } : {})} style={index > 0 ? { marginTop: spacing.sm } : undefined}>
                    {customRenderShellCard
                      ? customRenderShellCard({ shell: item.shell, onPress: pressHandler, selected: isSelected, onStop: shellOnStop, onRename: shellOnRename })
                      : <ShellCard shell={item.shell} onPress={pressHandler} selected={isSelected} onStop={shellOnStop} onRename={shellOnRename} />
                    }
                  </View>
                );
              }

              if (item.kind === "group-agent") {
                return (
                  <View key={key} style={{ marginTop: spacing.sm }}>
                    <GroupAgentRow
                      provider={resolveGroupAgentProvider(item.workDir)}
                      providers={resolvedAgentProviders}
                      onProviderChange={(provider) => handleSetGroupAgentProvider(item.workDir, provider)}
                      model={groupAgentModels[item.workDir] ?? defaultAgentModel ?? null}
                      modelOptions={agentModelOptions}
                      onModelChange={(provider, modelId) => handleSetGroupAgentModel(item.workDir, provider, modelId)}
                      onRunAgent={(prompt, provider, model) => onRunAgent!(prompt, item.workDir, provider, model)}
                      focusSignal={focusAgentWorkDir === item.workDir ? focusAgentSignal : undefined}
                      workDir={item.workDir}
                    />
                  </View>
                );
              }

              if (item.kind === "hidden-section") {
                return (
                  <View key={key} style={{ marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm }}>
                    <Text style={[styles.groupHeader, { fontSize: 10, color: colors.textMuted }]}>Hidden Groups</Text>
                  </View>
                );
              }

              if (item.kind === "hidden-header") {
                return (
                  <View key={key} style={{ marginTop: spacing.xs }}>
                    <View style={[styles.groupHeaderRow, { opacity: 0.5 }]}>
                      <Text style={styles.groupHeader}>{item.displayGroup}</Text>
                      <View style={{ flex: 1 }} />
                      {onUnhideGroup && (
                        <TouchableOpacity
                          onPress={() => onUnhideGroup(item.group)}
                          style={styles.addJobBtn}
                          activeOpacity={0.6}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={{ fontSize: 11, color: colors.textMuted }}>Show</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              }

              return null;
            })(),
      );
      index += 1;
    }
    return rendered;
  };

  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Name";

  const handleSelectSort = useCallback((mode: JobSortMode) => {
    onSortChange?.(mode);
    setSortOpen(false);
  }, [onSortChange]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    (document.activeElement as HTMLElement)?.blur();
  }, []);

  const toolbar = (onSortChange && jobs.length > 1) || jobs.length > 0 ? (
    <View style={styles.sortRow}>
      <View style={styles.searchBar}>
        <Text style={styles.searchIcon}>{"\u2315"}</Text>
        <TextInput
          ref={searchRef}
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Filter jobs..."
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          inputAccessoryViewID={Platform.OS === "ios" ? "keyboard-dismiss" : undefined}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Escape") {
              handleClearSearch();
            }
          }}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={handleClearSearch} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.searchClear}>x</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={{ flex: 1 }} />
      {onSortChange && jobs.length > 1 && (
        <View>
          <TouchableOpacity
            ref={sortTriggerRef}
            onPress={() => setSortOpen(!sortOpen)}
            style={styles.sortTrigger}
            activeOpacity={0.6}
          >
            <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
            <Text style={styles.sortTriggerArrow}>{sortOpen ? "\u25B4" : "\u25BE"}</Text>
          </TouchableOpacity>
          {sortOpen && (
            <PopupMenu
              items={SORT_OPTIONS.map((opt) => ({
                type: "item" as const,
                label: opt.label,
                onPress: () => handleSelectSort(opt.value),
                active: sortMode === opt.value,
              }))}
              triggerRef={sortTriggerRef}
              onClose={() => setSortOpen(false)}
            />
          )}
        </View>
      )}
    </View>
  ) : null;

  // Scroll a specific job into view when scrollToSlug changes
  const prevScrollSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollToSlug || Platform.OS !== "web") return;
    if (scrollToSlug === prevScrollSlug.current) return;
    prevScrollSlug.current = scrollToSlug;
    const escaped = CSS.escape(scrollToSlug);
    const el = (
      document.querySelector(`[data-job-slug="${escaped}"]`) ??
      document.querySelector(`[data-process-id="${escaped}"]`) ??
      document.querySelector(`[data-shell-id="${escaped}"]`)
    ) as HTMLElement | null;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [scrollToSlug]);

  // Restore scroll position on mount
  useEffect(() => {
    if (!initialScrollOffset) return;
    // Double rAF to wait for layout, plus a fallback timeout
    const restore = () => scrollRef.current?.scrollTo({ y: initialScrollOffset, animated: false });
    requestAnimationFrame(() => requestAnimationFrame(restore));
    const t = setTimeout(restore, 100);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On macOS WebKit, elastic bounce won't re-trigger when scroll is pinned at
  // the exact boundary (0 or scrollHeight). Keep 1px of scroll room so the
  // rubber-band effect can fire repeatedly.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (scrollRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (node.scrollTop <= 0) {
          node.scrollTop = 1;
        } else if (node.scrollTop + node.clientHeight >= node.scrollHeight) {
          node.scrollTop = node.scrollHeight - node.clientHeight - 1;
        }
      }, 150);
    };
    // Set initial 1px offset so first top-bounce works after content loads
    requestAnimationFrame(() => { if (node.scrollTop === 0 && node.scrollHeight > node.clientHeight) node.scrollTop = 1; });
    node.addEventListener("scroll", nudge, { passive: true });
    return () => { node.removeEventListener("scroll", nudge); if (timer) clearTimeout(timer); };
  }, []);

  const handleContainerMouseDown = useCallback(() => {
    if (Platform.OS !== "web") return;
    const container = (containerRef.current as any) as HTMLElement | undefined;
    if (!container) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && !container.contains(active)) {
      (document.activeElement as HTMLElement)?.blur?.();
    }
  }, []);

  const containerWebProps = Platform.OS === "web"
    ? { tabIndex: -1 as const, onMouseDown: handleContainerMouseDown, style: { flex: 1, outline: "none" } as const }
    : {};

  return (
    <View
      ref={containerRef}
      style={Platform.OS !== "web" ? { flex: 1 } : undefined}
      {...containerWebProps}
    >
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.list, contentContainerStyle]}
      scrollEnabled={scrollEnabled}
      automaticallyAdjustKeyboardInsets
      onScroll={(e) => { onScrollOffsetChange?.(e.nativeEvent.contentOffset.y); }}
      scrollEventThrottle={100}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={false}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        ) : undefined
      }
    >
      {headerContent}
      {toolbar}
      {renderItemsWithSortableGroups()}
      {groupMenu && (onAddJob || onHideGroup) && (
        <PopupMenu
          items={[
            ...(onAddJob ? [{ type: "item" as const, label: "Add Job", onPress: () => onAddJob(groupMenu.group, groupMenu.folderPath) }] : []),
            ...(onHideGroup ? [{ type: "item" as const, label: "Hide Group", onPress: () => onHideGroup(groupMenu.group) }] : []),
          ]}
          position={groupMenuPos}
          dropdownRef={groupMenuDropdownRef}
          triggerRef={groupMenuTriggerRef}
          onClose={() => setGroupMenu(null)}
        />
      )}
    </ScrollView>
    </View>
  );
}


const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  list: {
    padding: spacing.lg,
  },
  jobWithPaneToggle: {
    position: "relative",
  },
  jobPaneToggle: {
    position: "absolute",
    top: spacing.xs,
    left: spacing.xs,
    zIndex: 5,
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  jobPaneToggleText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
  },
  jobChildProcesses: {
    marginTop: spacing.xs,
    marginLeft: spacing.lg,
    paddingLeft: spacing.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  jobChildProcess: {
    opacity: 0.96,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  emptyText: { color: colors.textSecondary, fontSize: 14 },
  groupHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  addJobBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  addJobBtnText: {
    color: colors.textSecondary,
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 20,
    letterSpacing: 1,
  },
  groupHeaderArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  groupFolderPath: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
    minWidth: 0,
  },
  searchIcon: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    maxWidth: 240,
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 4,
    outlineStyle: "none",
  } as any,
  searchClear: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
    paddingHorizontal: 4,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xs,
    zIndex: 10,
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  sortTriggerText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  sortTriggerArrow: {
    color: colors.textSecondary,
    fontSize: 10,
  },
});
