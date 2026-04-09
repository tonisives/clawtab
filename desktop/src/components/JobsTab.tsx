import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { RemoteJob, JobSortMode, JobStatus } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, ProcessProvider, ShellPane } from "@clawtab/shared";
import {
  JobListView,
  NotificationSection,
  AutoYesBanner,
  SplitDetailArea,
  DropZoneOverlay,
  JobCard,
  RunningJobCard,
  ProcessCard,
  NotificationCard,
  useJobsCore,
  useJobActions,
  useSplitTree,
  collectLeaves,
  shortenPath,
  type SidebarSelectableItem,
} from "@clawtab/shared";
import type { AutoYesEntry, PaneContent, SplitDragData } from "@clawtab/shared";
import { createTauriTransport } from "../transport/tauriTransport";
import type { AppSettings, Job } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetectedProcessDetail } from "./DetectedProcessDetail";
import { DesktopJobDetail, AgentDetail } from "./JobDetailSections";
import { ParamsOverlay } from "./ParamsOverlay";
import { DraggableJobCard, DraggableNotificationCard, DraggableProcessCard, type DragData } from "./DraggableCards";
import { SkillSearchDialog } from "./SkillSearchDialog";
import { InjectSecretsDialog } from "./InjectSecretsDialog";
import { ShellPaneDetail } from "./ShellPaneDetail";
import { EditTextDialog } from "./EditTextDialog";
import { useQuestionPolling } from "../hooks/useQuestionPolling";
import { useAutoYes } from "../hooks/useAutoYes";
import { useImportJob } from "../hooks/useImportJob";
import { DEFAULT_SHORTCUTS, resolveShortcutSettings, shortcutMatches, type ShortcutSettings } from "../shortcuts";

const transport = createTauriTransport();

interface JobsTabProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
  importCwtKey?: number;
  pendingPaneId?: string | null;
  onPaneHandled?: () => void;
  navBar?: React.ReactNode;
  rightPanelOverlay?: React.ReactNode;
  onJobSelected?: () => void;
}

interface ExistingPaneInfo {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
}

function isShellPane(value: ShellPane | null): value is ShellPane {
  return value !== null;
}

const SINGLE_PANE_CACHE_LIMIT = 10;

function paneContentCacheKey(content: PaneContent): string {
  if (content.kind === "job") return content.slug;
  if (content.kind === "agent") return "_agent";
  if (content.kind === "terminal") return `_term_${content.paneId}`;
  return content.paneId;
}

function shouldCacheSinglePaneContent(content: PaneContent): boolean {
  return content.kind === "job" || content.kind === "agent";
}

function providerCapabilities(provider: ProcessProvider): Pick<DetectedProcess, "can_fork_session" | "can_send_skills" | "can_inject_secrets"> {
  if (provider === "claude") {
    return { can_fork_session: true, can_send_skills: true, can_inject_secrets: true };
  }
  return { can_fork_session: false, can_send_skills: false, can_inject_secrets: false };
}

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled, navBar, rightPanelOverlay, onJobSelected }: JobsTabProps) {
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings>(DEFAULT_SHORTCUTS);
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

  // Navigation state
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTemplateId, setPickerTemplateId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewingJob, setViewingJob] = useState<Job | null>(null);
  const [viewingProcess, setViewingProcess] = useState<DetectedProcess | null>(null);
  const [viewingShell, setViewingShell] = useState<ShellPane | null>(null);
  const [createForGroup, setCreateForGroup] = useState<{ group: string; folderPath: string | null } | null>(null);
  const [viewingAgent, setViewingAgent] = useState(false);
  const [paramsDialog, setParamsDialog] = useState<{ job: Job; values: Record<string, string> } | null>(null);
  const [pendingAgentWorkDir, setPendingAgentWorkDir] = useState<{ dir: string; startedAt: number } | null>(null);
  const [scrollToSlug, setScrollToSlug] = useState<string | null>(null);
  const [pendingProcess, setPendingProcess] = useState<DetectedProcess | null>(null);
  const [stoppingProcesses, setStoppingProcesses] = useState<{ process: DetectedProcess; stoppedAt: number }[]>([]);
  const [stoppingJobSlugs, setStoppingJobSlugs] = useState<Set<string>>(new Set());
  const [shellPanes, setShellPanes] = useState<ShellPane[]>([]);
  const previousProcessesRef = useRef<Map<string, DetectedProcess>>(new Map());
  const [editProcessField, setEditProcessField] = useState<{
    paneId: string;
    title: string;
    label: string;
    field: "display_name" | "first_query" | "last_query";
    initialValue: string;
    placeholder?: string;
  } | null>(null);

  // Clear stopping job slugs when job is no longer running
  useEffect(() => {
    if (stoppingJobSlugs.size === 0) return;
    const next = new Set<string>();
    for (const slug of stoppingJobSlugs) {
      if (core.statuses[slug]?.state === "running") next.add(slug);
    }
    if (next.size !== stoppingJobSlugs.size) setStoppingJobSlugs(next);
  }, [core.statuses, stoppingJobSlugs]);

  // Split tree (shared hook)

  // Pane action dialogs
  const [skillSearchPaneId, setSkillSearchPaneId] = useState<string | null>(null);
  const [injectSecretsPaneId, setInjectSecretsPaneId] = useState<string | null>(null);

  // Missed cron jobs
  const [missedCronJobs, setMissedCronJobs] = useState<string[]>([]);

  // --- Extracted hooks ---

  const questionPolling = useQuestionPolling();
  const { questions, startFastQuestionPoll } = questionPolling;

  const autoYes = useAutoYes(
    questions,
    core.processes,
    core.jobs as Job[],
    startFastQuestionPoll,
  );

  const blurSelectionFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") active.blur();
    });
  }, []);

  const handleSelectJobDirect = useCallback((job: RemoteJob) => {
    setViewingProcess(null);
    setViewingShell(null);
    setViewingAgent(false);
    setViewingJob(job as Job);
    blurSelectionFocus();
    onJobSelected?.();
  }, [blurSelectionFocus, onJobSelected]);

  const handleSelectProcessDirect = useCallback((process: DetectedProcess) => {
    setViewingJob(null);
    setViewingShell(null);
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingProcess(null);
      setViewingAgent(true);
      blurSelectionFocus();
      onJobSelected?.();
      return;
    }
    setViewingAgent(false);
    setViewingProcess(process);
    blurSelectionFocus();
    onJobSelected?.();
  }, [blurSelectionFocus, onJobSelected]);

  const handleSelectShellDirect = useCallback((shell: ShellPane) => {
    setViewingJob(null);
    setViewingProcess(null);
    setViewingAgent(false);
    setViewingShell(shell);
    blurSelectionFocus();
    onJobSelected?.();
  }, [blurSelectionFocus, onJobSelected]);

  // Compute current single-pane content for the split tree hook
  const currentContent: PaneContent | null = useMemo(() => {
    if (viewingAgent) return { kind: "agent" };
    if (viewingShell) return { kind: "terminal", paneId: viewingShell.pane_id, tmuxSession: viewingShell.tmux_session };
    if (viewingProcess) return { kind: "process", paneId: viewingProcess.pane_id };
    if (viewingJob) return { kind: "job", slug: viewingJob.slug };
    return null;
  }, [viewingAgent, viewingShell, viewingProcess, viewingJob]);

  const split = useSplitTree({
    storageKey: "desktop_split_tree",
    minPaneSize: 200,
    onCollapse: useCallback((content: PaneContent) => {
      if (content.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === content.slug);
        if (job) { setViewingJob(job); setViewingProcess(null); setViewingShell(null); setViewingAgent(false); }
      } else if (content.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === content.paneId);
        if (proc) { setViewingProcess(proc); setViewingJob(null); setViewingShell(null); setViewingAgent(false); }
      } else if (content.kind === "terminal") {
        const shell = shellPanes.find((p) => p.pane_id === content.paneId);
        if (shell) { setViewingShell(shell); setViewingJob(null); setViewingProcess(null); setViewingAgent(false); }
      } else if (content.kind === "agent") {
        setViewingAgent(true); setViewingJob(null); setViewingProcess(null); setViewingShell(null);
      }
    }, [core.jobs, core.processes, shellPanes]),
    onReplaceSingle: useCallback((data: SplitDragData) => {
      if (data.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === data.slug);
        if (job) handleSelectJobDirect(job as unknown as RemoteJob);
      } else if (data.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === data.paneId);
        if (proc) handleSelectProcessDirect(proc);
      }
    }, [core.jobs, core.processes, handleSelectJobDirect, handleSelectProcessDirect]),
    currentContent,
  });

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((settings) => setShortcutSettings(resolveShortcutSettings(settings)))
      .catch(() => setShortcutSettings(DEFAULT_SHORTCUTS));

    const unlistenPromise = listen<AppSettings>("settings-updated", (event) => {
      setShortcutSettings(resolveShortcutSettings(event.payload));
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Wrap select handlers to check tree first
  const handleSelectJob = useCallback((job: RemoteJob) => {
    const content: PaneContent = { kind: "job", slug: job.slug };
    if (split.tree && split.handleSelectInTree(content)) return;
    handleSelectJobDirect(job);
  }, [split.tree, split.handleSelectInTree, handleSelectJobDirect]);

  const handleSelectProcess = useCallback((process: DetectedProcess) => {
    if (process.cwd.endsWith("/clawtab/agent")) {
      const content: PaneContent = { kind: "agent" };
      if (split.tree && split.handleSelectInTree(content)) return;
      handleSelectProcessDirect(process);
      return;
    }
    const content: PaneContent = { kind: "process", paneId: process.pane_id };
    if (split.tree && split.handleSelectInTree(content)) return;
    handleSelectProcessDirect(process);
  }, [split.tree, split.handleSelectInTree, handleSelectProcessDirect]);

  const handleSelectShell = useCallback((shell: ShellPane) => {
    const content: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
    if (split.tree && split.handleSelectInTree(content)) return;
    handleSelectShellDirect(shell);
  }, [split.tree, split.handleSelectInTree, handleSelectShellDirect]);

  const importJob = useImportJob(core.jobs as Job[], core.reload);

  // --- Fork handlers ---

  const handleFork = useCallback(async (paneId: string, direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane", { paneId, direction });
      await core.reload();
      // Add the new pane to the split tree
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === paneId);
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, { kind: "process", paneId: newPaneId }, treeDirection);
      }
    } catch (e) {
      console.error("fork_pane failed:", e);
    }
  }, [core.reload, split.tree, split.addSplitLeaf]);

  const handleForkWithSecrets = useCallback(async (paneId: string, secretKeys: string[], direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane_with_secrets", { paneId, secretKeys, direction });
      await core.reload();
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === paneId);
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, { kind: "process", paneId: newPaneId }, treeDirection);
      }
    } catch (e) {
      console.error("fork_pane_with_secrets failed:", e);
    }
  }, [core.reload, split.tree, split.addSplitLeaf]);

  const handleSplitPane = useCallback(async (paneId: string, direction: "right" | "down") => {
    try {
      const baseShell = await invoke<ShellPane>("split_pane_plain", { paneId, direction });
      const sourceProc = core.processes.find((p) => p.pane_id === paneId);
      const sourceShell = shellPanes.find((p) => p.pane_id === paneId);
      const sourceJob = (core.jobs as Job[]).find((job) => {
        const status = core.statuses[job.slug];
        return status?.state === "running" && (status as { pane_id?: string }).pane_id === paneId;
      });
      const shell: ShellPane = {
        ...baseShell,
        matched_group: sourceProc?.matched_group
          ?? sourceShell?.matched_group
          ?? sourceJob?.group
          ?? null,
      };
      setShellPanes((prev) => prev.some((p) => p.pane_id === shell.pane_id) ? prev : [...prev, shell]);
      setScrollToSlug(shell.pane_id);
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => (l.content.kind === "process" || l.content.kind === "terminal") && l.content.paneId === paneId);
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session }, treeDirection);
      } else {
        split.addSplitLeaf("_root", { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session }, treeDirection);
      }
    } catch (e) {
      console.error("split_pane_plain failed:", e);
    }
  }, [core.processes, core.jobs, core.statuses, shellPanes, split.tree, split.addSplitLeaf]);

  // --- Settings & event listeners ---

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

  useEffect(() => {
    const unlistenPromise = listen("jobs-changed", () => { core.reload(); });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [core.reload]);

  useEffect(() => {
    const unlistenPromise = listen<string[]>("missed-cron-jobs", (event) => {
      if (event.payload.length > 0) setMissedCronJobs(event.payload);
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // Sync viewing state with reloaded data
  useEffect(() => {
    if (viewingJob) {
      const fresh = (core.jobs as Job[]).find((j) => j.slug === viewingJob.slug);
      if (fresh && fresh !== viewingJob) setViewingJob(fresh);
    }
  }, [core.jobs, viewingJob]);

  useEffect(() => {
    if (viewingProcess) {
      if (viewingProcess.pane_id.startsWith("_pending_")) return;
      const fresh = core.processes.find((p) => p.pane_id === viewingProcess.pane_id);
      if (!fresh) {
        const awaitingDetection =
          !!pendingAgentWorkDir &&
          pendingProcess?.pane_id === viewingProcess.pane_id;
        if (awaitingDetection) return;
        setViewingProcess(null);
      }
      else if (fresh !== viewingProcess) setViewingProcess(fresh);
    }
  }, [core.processes, viewingProcess, pendingAgentWorkDir, pendingProcess]);

  useEffect(() => {
    if (!viewingShell) return;
    const fresh = shellPanes.find((p) => p.pane_id === viewingShell.pane_id);
    if (!fresh) setViewingShell(null);
    else if (fresh !== viewingShell) setViewingShell(fresh);
  }, [shellPanes, viewingShell]);

  useEffect(() => {
    const previous = previousProcessesRef.current;
    const currentMap = new Map(core.processes.map((process) => [process.pane_id, process]));
    const stoppingIds = new Set(stoppingProcesses.map((entry) => entry.process.pane_id));
    const shellPaneIds = new Set(shellPanes.map((pane) => pane.pane_id));
    const removed = Array.from(previous.values()).filter((process) =>
      !currentMap.has(process.pane_id)
      && !stoppingIds.has(process.pane_id)
      && process.pane_id !== pendingProcess?.pane_id
      && !shellPaneIds.has(process.pane_id),
    );

    previousProcessesRef.current = currentMap;

    if (removed.length === 0) return;

    let cancelled = false;

    Promise.all(
      removed.map(async (process): Promise<ShellPane | null> => {
        const info = await invoke<ExistingPaneInfo | null>("get_existing_pane_info", { paneId: process.pane_id }).catch(() => null);
        if (!info) return null;
        const shell: ShellPane = {
          pane_id: info.pane_id,
          cwd: info.cwd,
          tmux_session: info.tmux_session,
          window_name: info.window_name,
          matched_group: process.matched_group ?? null,
        };
        return shell;
      }),
    ).then((results) => {
      if (cancelled) return;
      const demoted = results.filter(isShellPane);
      if (demoted.length === 0) return;

      const demotedIds = new Set(demoted.map((shell) => shell.pane_id));
      setShellPanes((prev) => {
        const existing = new Set(prev.map((pane) => pane.pane_id));
        const additions = demoted.filter((shell) => !existing.has(shell.pane_id));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });

      for (const shell of demoted) {
        split.replaceContent(
          { kind: "process", paneId: shell.pane_id },
          { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session },
        );
      }

      if (viewingProcess && demotedIds.has(viewingProcess.pane_id)) {
        const shell = demoted.find((entry) => entry.pane_id === viewingProcess.pane_id);
        if (shell) {
          setViewingProcess(null);
          setViewingShell(shell);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [core.processes, pendingProcess, shellPanes, split.replaceContent, stoppingProcesses, viewingProcess]);

  useEffect(() => {
    if (!pendingAgentWorkDir) return;
    const { dir, startedAt } = pendingAgentWorkDir;
    // If we already have a real pane_id, match by it directly
    const pendingPaneId = pendingProcess && !pendingProcess.pane_id.startsWith("_pending_") ? pendingProcess.pane_id : null;
    const match = core.processes.find((p) =>
      pendingPaneId
        ? p.pane_id === pendingPaneId
        : (p.cwd === dir && !p.pane_id.startsWith("_pending_") &&
           p.session_started_at && new Date(p.session_started_at).getTime() >= startedAt - 5000),
    );
    if (match) {
      setPendingAgentWorkDir(null);
      setPendingProcess(null);
      if (split.tree) {
        const matchContent: PaneContent = { kind: "process", paneId: match.pane_id };
        const pendingContent = pendingProcess ? { kind: "process" as const, paneId: pendingProcess.pane_id } : null;
        if (!pendingContent || !split.replaceContent(pendingContent, matchContent)) {
          split.openContent(matchContent);
        }
      } else {
        setViewingProcess(match);
      }
      setScrollToSlug(match.pane_id);
      return;
    }
    if (Date.now() - startedAt > 15000) {
      setPendingAgentWorkDir(null);
      setPendingProcess(null);
    }
  }, [core.processes, pendingAgentWorkDir, pendingProcess, split.tree, split.openContent, split.replaceContent]);

  useEffect(() => {
    if (stoppingProcesses.length === 0) return;
    const MIN_STOPPING_VISIBLE_MS = 1500;
    const MAX_STOPPING_VISIBLE_MS = 10000;
    setStoppingProcesses((prev) =>
      prev.filter((sp) => {
        const stillPresent = core.processes.some((p) => p.pane_id === sp.process.pane_id);
        const elapsed = Date.now() - sp.stoppedAt;
        if (elapsed >= MAX_STOPPING_VISIBLE_MS) return false;
        if (stillPresent) return true;
        return elapsed < MIN_STOPPING_VISIBLE_MS;
      }),
    );
  }, [core.processes, stoppingProcesses.length]);

  useEffect(() => {
    if (!pendingPaneId) return;
    console.log("[open-pane] looking for pane:", pendingPaneId,
      "jobs:", (core.jobs as Job[]).map((j) => ({ slug: j.slug, pane: (core.statuses[j.slug] as { pane_id?: string })?.pane_id })),
      "processes:", core.processes.map((p) => p.pane_id));
    for (const job of core.jobs as Job[]) {
      const status = core.statuses[job.slug];
      if (status?.state === "running") {
        const paneId = (status as { pane_id?: string }).pane_id;
        if (paneId === pendingPaneId) {
          setViewingJob(job);
          onPaneHandled?.();
          return;
        }
      }
    }
    const proc = core.processes.find((p) => p.pane_id === pendingPaneId);
    if (proc) {
      setViewingProcess(proc);
      onPaneHandled?.();
      return;
    }
    if (core.loaded) {
      console.warn("[open-pane] no job or process found for pane:", pendingPaneId);
      onPaneHandled?.();
    }
  }, [pendingPaneId, core.jobs, core.statuses, core.processes, core.loaded, onPaneHandled]);

  useEffect(() => {
    if (pendingTemplateId) setShowPicker(true);
  }, [pendingTemplateId]);

  useEffect(() => {
    if (createJobKey && createJobKey > 0) setIsCreating(true);
  }, [createJobKey]);

  useEffect(() => {
    if (importCwtKey && importCwtKey > 0) importJob.handleImportCwt();
  }, [importCwtKey]);

  // Resizable list pane
  const [listWidth, setListWidth] = useState(() => {
    const v = localStorage.getItem("desktop_list_pane_width");
    if (v) return Math.max(260, Math.min(600, parseInt(v, 10)));
    return 380;
  });
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const onResizeHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.pageX;
    const startW = listWidthRef.current;
    const onMouseMove = (ev: MouseEvent) => {
      const w = Math.max(260, Math.min(600, startW + (ev.pageX - startX)));
      setListWidth(w);
      localStorage.setItem("desktop_list_pane_width", String(w));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Responsive
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const isWide = windowWidth >= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSelectableItems, setSidebarSelectableItems] = useState<SidebarSelectableItem[]>([]);
  const [recentSinglePaneContents, setRecentSinglePaneContents] = useState<PaneContent[]>([]);
  const sidebarFocusRef = useRef<{ focus: () => void } | null>(null);

  const navigateSidebarItems = useCallback((direction: 1 | -1) => {
    if (sidebarSelectableItems.length === 0) return;
    sidebarFocusRef.current?.focus();

    const currentKey = split.focusedItemKey
      ?? (viewingShell
        ? `_term_${viewingShell.pane_id}`
        : viewingProcess
          ? viewingProcess.pane_id
          : viewingJob?.slug ?? null);
    const currentIndex = currentKey
      ? sidebarSelectableItems.findIndex((item) => item.key === currentKey)
      : -1;
    const baseIndex = currentIndex === -1
      ? (direction > 0 ? -1 : 0)
      : currentIndex;
    const nextIndex = (baseIndex + direction + sidebarSelectableItems.length) % sidebarSelectableItems.length;
    const nextItem = sidebarSelectableItems[nextIndex];
    if (!nextItem) return;

    if (nextItem.kind === "job") {
      handleSelectJob(nextItem.job);
      setScrollToSlug(nextItem.job.slug);
      return;
    }
    if (nextItem.kind === "process") {
      handleSelectProcess(nextItem.process);
      setScrollToSlug(nextItem.process.pane_id);
      return;
    }
    handleSelectShell(nextItem.shell);
    setScrollToSlug(nextItem.shell.pane_id);
  }, [sidebarSelectableItems, split.focusedItemKey, viewingShell, viewingProcess, viewingJob, handleSelectJob, handleSelectProcess, handleSelectShell]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      const inXterm = !!target?.closest(".xterm");
      const isEditable = !!target && (
        target.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      );
      if (isEditable && !inXterm) return;

      if (shortcutMatches(e, shortcutSettings.next_sidebar_item)) {
        e.preventDefault();
        navigateSidebarItems(1);
        return;
      }

      if (shortcutMatches(e, shortcutSettings.previous_sidebar_item)) {
        e.preventDefault();
        navigateSidebarItems(-1);
        return;
      }

      if (shortcutMatches(e, shortcutSettings.toggle_sidebar)) {
        e.preventDefault();
        setSidebarCollapsed(prev => {
          const next = !prev;
          if (!next) requestAnimationFrame(() => sidebarFocusRef.current?.focus());
          return next;
        });
        return;
      }

      if (shortcutMatches(e, shortcutSettings.split_pane_vertical)) {
        e.preventDefault();
        const tree = split.tree;
        if (!tree) return;
        const leaves = collectLeaves(tree);
        const focused = leaves.find(l => l.id === split.focusedLeafId) ?? leaves[0];
        if (!focused) return;
        const c = focused.content;
        const paneId = (c.kind === "process" || c.kind === "terminal") ? c.paneId : null;
        if (paneId) handleSplitPane(paneId, "right");
        return;
      }

      if (shortcutMatches(e, shortcutSettings.split_pane_horizontal)) {
        e.preventDefault();
        const tree = split.tree;
        if (!tree) return;
        const leaves = collectLeaves(tree);
        const focused = leaves.find(l => l.id === split.focusedLeafId) ?? leaves[0];
        if (!focused) return;
        const c = focused.content;
        const paneId = (c.kind === "process" || c.kind === "terminal") ? c.paneId : null;
        if (paneId) handleSplitPane(paneId, "down");
        return;
      }

      if (
        shortcutMatches(e, shortcutSettings.move_pane_left)
        || shortcutMatches(e, shortcutSettings.move_pane_down)
        || shortcutMatches(e, shortcutSettings.move_pane_up)
        || shortcutMatches(e, shortcutSettings.move_pane_right)
      ) {
        e.preventDefault();
        const tree = split.tree;
        if (!tree) return;
        const leaves = collectLeaves(tree);
        if (leaves.length < 2) return;
        const currentIdx = leaves.findIndex(l => l.id === split.focusedLeafId);
        const idx = currentIdx === -1 ? 0 : currentIdx;
        let next = idx;
        if (
          shortcutMatches(e, shortcutSettings.move_pane_left)
          || shortcutMatches(e, shortcutSettings.move_pane_up)
        ) {
          next = (idx - 1 + leaves.length) % leaves.length;
        } else {
          next = (idx + 1) % leaves.length;
        }
        split.setFocusedLeafId(leaves[next].id);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [split.tree, split.focusedLeafId, split.setFocusedLeafId, handleSplitPane, navigateSidebarItems, shortcutSettings]);

  useEffect(() => {
    if (split.tree || !currentContent) return;
    setRecentSinglePaneContents((prev) => {
      const key = paneContentCacheKey(currentContent);
      const retained = prev.filter((item) => shouldCacheSinglePaneContent(item));
      const next = shouldCacheSinglePaneContent(currentContent)
        ? [currentContent, ...retained.filter((item) => paneContentCacheKey(item) !== key)]
        : retained;
      return next.slice(0, SINGLE_PANE_CACHE_LIMIT);
    });
  }, [split.tree, currentContent]);

  const isFullScreenView = !isWide && !!(editingJob || isCreating || showPicker);
  const trafficLightInsetStyle = isWide && sidebarCollapsed ? { paddingLeft: 84 } : undefined;
  useEffect(() => {
    const tabContent = document.querySelector(".tab-content") as HTMLElement | null;
    if (!tabContent) return;
    if (isFullScreenView || !isWide) {
      tabContent.style.overflowY = "auto";
      if (isFullScreenView) tabContent.scrollTop = 0;
    } else {
      tabContent.style.overflowY = "";
    }
    return () => { tabContent.style.overflowY = ""; };
  }, [isFullScreenView, isWide]);

  // --- Handlers ---

  const handleRunWithParams = useCallback(async () => {
    if (!paramsDialog) return;
    await actions.runJob(paramsDialog.job.slug, paramsDialog.values);
    setParamsDialog(null);
  }, [paramsDialog, actions]);

  const handleSave = useCallback(async (job: Job) => {
    setSaveError(null);
    try {
      const wasEditing = editingJob;
      const renamed = editingJob && job.name !== editingJob.name;
      if (renamed) {
        await invoke("rename_job", { oldName: editingJob.slug, job: { ...job, slug: "" } });
      } else {
        await invoke("save_job", { job });
      }
      const savedJobs = await invoke<Job[]>("get_jobs");
      const savedJob = savedJobs.find((candidate) => {
        if (wasEditing && candidate.slug === wasEditing.slug) return true;
        return (
          candidate.name === job.name &&
          candidate.job_type === job.job_type &&
          (candidate.group || "default") === (job.group || "default") &&
          (candidate.folder_path ?? "") === (job.folder_path ?? "") &&
          (candidate.work_dir ?? "") === (job.work_dir ?? "")
        );
      }) ?? savedJobs.find((candidate) => candidate.name === job.name);
      await core.reload();
      setEditingJob(null);
      setIsCreating(false);
      setCreateForGroup(null);
      if (savedJob) setViewingJob(savedJob);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setSaveError(msg);
      console.error("Failed to save job:", e);
    }
  }, [editingJob, core.reload]);

  const handleDuplicate = useCallback(async (job: Job, targetGroup: string) => {
    const allJobs = await invoke<Job[]>("get_jobs");
    const targetJobs = allJobs.filter((j) => (j.group || "default") === targetGroup && j.folder_path);
    const targetProjectPath = targetJobs.length > 0 ? targetJobs[0].folder_path : job.folder_path;
    if (!targetProjectPath) return;
    try {
      const newJob = await invoke<Job>("duplicate_job", { sourceSlug: job.slug, targetProjectPath });
      await core.reload();
      setViewingJob(newJob);
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  }, [core.reload]);

  const handleDuplicateToFolder = useCallback(async (job: Job) => {
    const selected = await open({ directory: true, title: "Choose folder for duplicated job" });
    if (!selected) return;
    const folder = typeof selected === "string" ? selected : selected[0];
    if (!folder) return;
    try {
      const newJob = await invoke<Job>("duplicate_job", { sourceSlug: job.slug, targetProjectPath: folder });
      await core.reload();
      setViewingJob(newJob);
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  }, [core.reload]);

  const handleOpen = useCallback(async (name: string) => {
    await invoke("focus_job_window", { name });
  }, []);

  const openRenameProcessDialog = useCallback((process: DetectedProcess) => {
    setEditProcessField({
      paneId: process.pane_id,
      title: "Edit pane title",
      label: "Title",
      field: "display_name",
      initialValue: process.display_name ?? "",
      placeholder: shortenPath(process.cwd),
    });
  }, []);

  const handleSaveProcessNameInline = useCallback(async (process: DetectedProcess, name: string) => {
    const normalizedValue = name.trim() || null;
    const paneId = process.pane_id;
    try {
      core.setProcesses((prev) => prev.map((proc) => (
        proc.pane_id === paneId ? { ...proc, display_name: normalizedValue } : proc
      )));
      setViewingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await invoke("set_detected_process_display_name", {
        paneId,
        displayName: normalizedValue,
      });
      setPendingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process name:", e);
    }
  }, [core]);

  const openEditProcessQueryDialog = useCallback((
    process: DetectedProcess,
    field: "first_query" | "last_query",
  ) => {
    const isLatest = field === "last_query";
    setEditProcessField({
      paneId: process.pane_id,
      title: isLatest ? "Edit latest query" : "Edit query",
      label: isLatest ? "Latest" : "Query",
      field,
      initialValue: (field === "first_query" ? process.first_query : process.last_query) ?? "",
      placeholder: isLatest ? "Latest query text" : "Query text",
    });
  }, []);

  const handleSaveProcessField = useCallback(async (value: string) => {
    if (!editProcessField) return;
    const normalizedValue = value.trim() || null;
    const paneId = editProcessField.paneId;
    try {
      if (editProcessField.field === "display_name") {
        core.setProcesses((prev) => prev.map((proc) => (
          proc.pane_id === paneId ? { ...proc, display_name: normalizedValue } : proc
        )));
        setViewingProcess((prev) => prev && prev.pane_id === paneId
          ? { ...prev, display_name: normalizedValue }
          : prev);
        await invoke("set_detected_process_display_name", {
          paneId,
          displayName: normalizedValue,
        });
        setPendingProcess((prev) => prev && prev.pane_id === paneId
          ? { ...prev, display_name: normalizedValue }
          : prev);
      } else {
        const proc = core.processes.find((item) => item.pane_id === paneId)
          ?? (pendingProcess?.pane_id === paneId ? pendingProcess : null);
        const nextFirstQuery = editProcessField.field === "first_query"
          ? normalizedValue
          : (proc?.first_query ?? null);
        const nextLastQuery = editProcessField.field === "last_query"
          ? normalizedValue
          : (proc?.last_query ?? null);
        core.setProcesses((prev) => prev.map((item) => (
          item.pane_id === paneId
            ? { ...item, first_query: nextFirstQuery, last_query: nextLastQuery }
            : item
        )));
        setViewingProcess((prev) => prev && prev.pane_id === paneId
          ? { ...prev, first_query: nextFirstQuery, last_query: nextLastQuery }
          : prev);
        setPendingProcess((prev) => prev && prev.pane_id === paneId
          ? { ...prev, first_query: nextFirstQuery, last_query: nextLastQuery }
          : prev);
        await invoke("set_detected_process_queries", {
          paneId,
          firstQuery: nextFirstQuery,
          lastQuery: nextLastQuery,
        });
      }
      setEditProcessField(null);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process edit:", e);
    }
  }, [editProcessField, core, pendingProcess]);

  type ListItemRef =
    | { kind: "job"; slug: string; job: Job }
    | { kind: "process"; paneId: string; process: DetectedProcess }
    | { kind: "terminal"; paneId: string; shell: ShellPane };
  const orderedItems = useMemo(() => {
    const result: ListItemRef[] = [];
    const jobs = core.jobs as Job[];
    const grouped = new Map<string, Job[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [group, gJobs] of grouped) {
        const manualOrder = jobOrder[group] ?? [];
        const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
        gJobs.sort((a, b) => {
          const aIndex = manualIndex.get(a.slug);
          const bIndex = manualIndex.get(b.slug);
          if (aIndex != null && bIndex != null) return aIndex - bIndex;
          if (aIndex != null) return -1;
          if (bIndex != null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }
    const keys = [...grouped.keys()];
    if (sortMode === "name") {
      keys.sort((a, b) => {
        const da = a === "default" ? "General" : a;
        const db = b === "default" ? "General" : b;
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }
    const stoppingIds = new Set(stoppingProcesses.map((sp) => sp.process.pane_id));
    const allProcs = [
      ...core.processes.filter((p) => !stoppingIds.has(p.pane_id)),
      ...stoppingProcesses.map((sp) => sp.process),
      ...(pendingProcess ? [pendingProcess] : []),
    ];
    for (const key of keys) {
      for (const job of grouped.get(key) ?? []) result.push({ kind: "job", slug: job.slug, job });
      for (const proc of allProcs) {
        if (proc.matched_group === key) result.push({ kind: "process", paneId: proc.pane_id, process: proc });
      }
    }
    for (const proc of allProcs) {
      if (!proc.matched_group) result.push({ kind: "process", paneId: proc.pane_id, process: proc });
    }
    for (const shell of shellPanes) {
      result.push({ kind: "terminal", paneId: shell.pane_id, shell });
    }
    return result;
  }, [core.jobs, core.processes, sortMode, jobOrder, pendingProcess, stoppingProcesses, shellPanes]);

  const selectAdjacentItem = useCallback((currentId: string) => {
    const idx = orderedItems.findIndex((it) =>
      it.kind === "job" ? it.slug === currentId : it.paneId === currentId,
    );
    const prevIdx = idx > 0 ? idx - 1 : (orderedItems.length > 1 ? 1 : -1);
    if (prevIdx >= 0 && prevIdx < orderedItems.length) {
      const next = orderedItems[prevIdx];
      if (next.kind === "job") {
        setViewingProcess(null); setViewingShell(null); setViewingAgent(false); setViewingJob(next.job); setScrollToSlug(next.slug);
      } else if (next.kind === "terminal") {
        setViewingJob(null); setViewingProcess(null); setViewingAgent(false); setViewingShell(next.shell); setScrollToSlug(next.paneId);
      } else {
        setViewingJob(null); setViewingShell(null); setViewingAgent(false); setViewingProcess(next.process); setScrollToSlug(next.paneId);
      }
    } else {
      setViewingJob(null); setViewingProcess(null); setViewingShell(null);
    }
  }, [orderedItems]);

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

  const handleJobReorder = useCallback((sourceSlug: string, targetSlug: string) => {
    const jobs = core.jobs as Job[];
    const sourceJob = jobs.find((job) => job.slug === sourceSlug);
    const targetJob = jobs.find((job) => job.slug === targetSlug);
    if (!sourceJob || !targetJob) return false;
    const sourceGroup = sourceJob.group || "default";
    const targetGroup = targetJob.group || "default";
    if (sourceGroup !== targetGroup) return false;

    const groupJobs = jobs.filter((job) => (job.group || "default") === sourceGroup).slice();
    const manualOrder = jobOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
    groupJobs.sort((a, b) => {
      const aIndex = manualIndex.get(a.slug);
      const bIndex = manualIndex.get(b.slug);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return a.name.localeCompare(b.name);
    });

    const fromIndex = groupJobs.findIndex((job) => job.slug === sourceSlug);
    const toIndex = groupJobs.findIndex((job) => job.slug === targetSlug);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupJobs];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    persistJobOrder({
      ...jobOrder,
      [sourceGroup]: reordered.map((job) => job.slug),
    });
    return true;
  }, [core.jobs, jobOrder, persistJobOrder]);

  const handleProcessReorder = useCallback((sourcePaneId: string, targetPaneId: string) => {
    const allProcesses = [...core.processes, ...stoppingProcesses.map((entry) => entry.process), ...(pendingProcess ? [pendingProcess] : [])];
    const sourceProcess = allProcesses.find((process) => process.pane_id === sourcePaneId);
    const targetProcess = allProcesses.find((process) => process.pane_id === targetPaneId);
    if (!sourceProcess || !targetProcess) return false;
    const sourceGroup = sourceProcess.matched_group ?? `cwd:${sourceProcess.cwd}`;
    const targetGroup = targetProcess.matched_group ?? `cwd:${targetProcess.cwd}`;
    if (sourceGroup !== targetGroup) return false;

    const groupProcesses = allProcesses.filter((process) => (process.matched_group ?? `cwd:${process.cwd}`) === sourceGroup);
    const manualOrder = processOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
    groupProcesses.sort((a, b) => {
      const aIndex = manualIndex.get(a.pane_id);
      const bIndex = manualIndex.get(b.pane_id);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
    });

    const fromIndex = groupProcesses.findIndex((process) => process.pane_id === sourcePaneId);
    const toIndex = groupProcesses.findIndex((process) => process.pane_id === targetPaneId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupProcesses];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    persistProcessOrder({
      ...processOrder,
      [sourceGroup]: reordered.map((process) => process.pane_id),
    });
    return true;
  }, [core.processes, pendingProcess, processOrder, persistProcessOrder, stoppingProcesses]);

  const blurActiveListElement = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") active.blur();
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    split.handleDragStart(event);
  }, [split.handleDragStart]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    split.handleDragMove(event);
  }, [split.handleDragMove]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const data = event.active.data.current as DragData | null;
    const overId = typeof event.over?.id === "string" ? event.over.id : null;
    if (data?.kind === "job" && overId) {
      handleJobReorder(data.slug, overId);
    }
    if (data?.kind === "process" && overId) {
      handleProcessReorder(data.paneId, overId);
    }
    split.handleDragEnd(event);
    blurActiveListElement();
  }, [blurActiveListElement, handleJobReorder, handleProcessReorder, split.handleDragEnd]);

  const handleDragCancel = useCallback(() => {
    split.handleDragCancel();
    blurActiveListElement();
  }, [blurActiveListElement, split.handleDragCancel]);

  const handleGetAgentProviders = useCallback(async () => {
    return await transport.listAgentProviders?.() ?? [];
  }, []);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string, provider: ProcessProvider = "claude") => {
    const capabilities = providerCapabilities(provider);
    if (workDir) {
      const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
      const matchedGroup = matchingJob ? (matchingJob.group || "default") : null;
      // Show a placeholder while waiting for the pane to be created
      const placeholder: DetectedProcess = {
        pane_id: `_pending_${Date.now()}`, cwd: workDir, version: "", tmux_session: "", window_name: "",
        provider, ...capabilities,
        matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
        last_query: null, session_started_at: new Date().toISOString(), _transient_state: "starting",
      };
      setPendingProcess(placeholder);
      if (split.tree) {
        split.openContent({ kind: "process", paneId: placeholder.pane_id });
      } else {
        setViewingJob(null); setViewingAgent(false); setViewingProcess(placeholder);
      }
      setScrollToSlug(placeholder.pane_id);

      const result = await actions.runAgent(prompt, workDir, provider);
      if (result) {
        // Got the real pane - switch to it immediately
        const realProcess: DetectedProcess = {
          pane_id: result.pane_id, cwd: workDir, version: "", tmux_session: result.tmux_session, window_name: "",
          provider, ...capabilities,
          matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
          last_query: null, session_started_at: new Date().toISOString(),
        };
        setPendingProcess(realProcess);
        if (split.tree) {
          const realContent: PaneContent = { kind: "process", paneId: realProcess.pane_id };
          if (!split.replaceContent({ kind: "process", paneId: placeholder.pane_id }, realContent)) {
            split.openContent(realContent);
          }
        } else {
          setViewingProcess(realProcess);
        }
        setScrollToSlug(result.pane_id);
        // Clear pending state after next process poll picks it up
        setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      } else {
        // Fallback: poll for the process (timeout case)
        setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      }
    } else {
      await actions.runAgent(prompt, workDir, provider);
    }
  }, [actions, core.jobs, split.tree, split.openContent, split.replaceContent]);

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

  const handleAddJob = useCallback((group: string, folderPath?: string) => {
    if (folderPath) {
      const cleanGroup = group.startsWith("_det_")
        ? group.slice(5).split("/").filter(Boolean).pop() ?? group
        : group;
      setCreateForGroup({ group: cleanGroup, folderPath });
      setIsCreating(true);
      return;
    }
    const jobs = core.jobs as Job[];
    const groupJobs = jobs.filter((j) => (j.group || "default") === group);
    const isFolderGroup = groupJobs.length > 0 && groupJobs.every((j) => j.job_type === "job");
    setCreateForGroup({
      group,
      folderPath: isFolderGroup ? groupJobs[0]?.folder_path ?? null : null,
    });
    setIsCreating(true);
  }, [core.jobs]);

  const handleQuestionNavigate = useCallback((q: ClaudeQuestion, resolvedJob: string | null) => {
    questionPolling.handleQuestionNavigate(q, resolvedJob, core.jobs as Job[], core.processes, setViewingJob, setViewingProcess);
  }, [core.jobs, core.processes, questionPolling]);

  const handleAutoYesPress = useCallback((entry: AutoYesEntry) => {
    const result = autoYes.handleAutoYesPress(entry);
    if (!result) return;
    if (result.kind === "job") { setViewingJob(result.job as Job); return; }
    if (result.kind === "process") { setViewingProcess(result.process); return; }
  }, [autoYes]);

  const handleRunMissedJobs = useCallback(async () => {
    const jobNames = missedCronJobs;
    setMissedCronJobs([]);
    for (const name of jobNames) {
      const job = (core.jobs as Job[]).find((j) => j.name === name);
      if (job) await actions.runJob(job.slug);
    }
  }, [missedCronJobs, core.jobs, actions]);

  // Clean stale process leaves from tree
  useEffect(() => {
    if (!core.loaded) return;
    split.cleanStaleLeaves((content) => {
      if (content.kind === "process") {
        if (pendingProcess?.pane_id === content.paneId) return false;
        if (shellPanes.find((p) => p.pane_id === content.paneId)) return false;
        return !core.processes.find(p => p.pane_id === content.paneId);
      }
      if (content.kind === "terminal") {
        return !shellPanes.find((p) => p.pane_id === content.paneId);
      }
      return false;
    });
  }, [core.processes, core.loaded, split.cleanStaleLeaves, pendingProcess, shellPanes]);

  // Promote shell panes to detected processes when claude/codex is launched inside them
  useEffect(() => {
    if (core.processes.length === 0 || shellPanes.length === 0) return;
    const processPaneIds = new Set(core.processes.map((p) => p.pane_id));
    const promoted = shellPanes.filter((s) => processPaneIds.has(s.pane_id));
    if (promoted.length === 0) return;
    const promotedIds = new Set(promoted.map((s) => s.pane_id));
    setShellPanes((prev) => prev.filter((s) => !promotedIds.has(s.pane_id)));
    for (const shell of promoted) {
      split.replaceContent(
        { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session },
        { kind: "process", paneId: shell.pane_id },
      );
    }
    if (viewingShell && promotedIds.has(viewingShell.pane_id)) {
      const proc = core.processes.find((p) => p.pane_id === viewingShell.pane_id);
      if (proc) {
        setViewingShell(null);
        setViewingProcess(proc);
      }
    }
  }, [core.processes, shellPanes, split.replaceContent, viewingShell]);

  // Helper: build DesktopJobDetail pane action props
  const buildJobPaneActions = useCallback((job: Job, jobQuestion: ClaudeQuestion | undefined) => ({
    autoYesActive: (() => {
      const paneId = jobQuestion?.pane_id ?? (core.statuses[job.slug]?.state === "running" ? (core.statuses[job.slug] as { pane_id?: string }).pane_id : undefined);
      return paneId ? autoYes.autoYesPaneIds.has(paneId) : false;
    })(),
    onToggleAutoYes: (() => {
      if (jobQuestion) return () => autoYes.handleToggleAutoYes(jobQuestion);
      const status = core.statuses[job.slug];
      if (status?.state === "running") {
        const paneId = (status as { pane_id?: string }).pane_id;
        if (paneId) return () => autoYes.handleToggleAutoYesByPaneId(paneId, job.name);
      }
      return undefined;
    })(),
    onFork: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? (direction: "right" | "down") => handleFork(paneId, direction) : undefined;
    })(),
    onSplitPane: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? (direction: "right" | "down") => handleSplitPane(paneId, direction) : undefined;
    })(),
    onInjectSecrets: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? () => setInjectSecretsPaneId(paneId) : undefined;
    })(),
    onSearchSkills: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? () => setSkillSearchPaneId(paneId) : undefined;
    })(),
  }), [core.statuses, autoYes, handleFork, handleSplitPane]);

  const buildJobTitlePath = useCallback((job: Job, _jobQuestion: ClaudeQuestion | undefined) => {
    const sourcePath = job.work_dir || job.folder_path || job.path;
    return sourcePath ? shortenPath(sourcePath) : undefined;
  }, []);

  const buildProcessTitlePath = useCallback((process: DetectedProcess) => {
    return shortenPath(process.cwd);
  }, []);

  const agentProcess = useMemo(
    () => core.processes.find((process) => process.cwd.endsWith("/clawtab/agent")) ?? null,
    [core.processes],
  );

  const agentJob = useMemo<RemoteJob>(() => ({
    name: agentProcess?.display_name ?? agentProcess?.first_query ?? "agent",
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "",
    slug: "agent",
  }), [agentProcess]);

  // Render a leaf pane in the split tree
  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    if (content.kind === "agent") {
      return (
        <AgentDetail
          transport={transport}
          job={agentJob}
          status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => split.handleClosePane(leafId)}
          onOpen={() => handleOpen("agent")}
          onEditTitle={agentProcess ? () => openRenameProcessDialog(agentProcess) : undefined}
          showBackButton={!isWide}
          hidePath
          contentStyle={trafficLightInsetStyle}
          titlePath={agentProcess ? buildProcessTitlePath(agentProcess) : "Agent"}
        />
      );
    }

    if (content.kind === "terminal") {
      const shell = shellPanes.find((p) => p.pane_id === content.paneId);
      if (!shell) {
        return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Shell pane not found</span></div>;
      }
      return (
        <ShellPaneDetail
          shell={shell}
          onBack={() => split.handleClosePane(leafId)}
          showBackButton={!isWide}
          hidePath
          onStopped={() => {
            setShellPanes((prev) => prev.filter((p) => p.pane_id !== shell.pane_id));
            split.handleClosePane(leafId);
          }}
          onSplitPane={(nextDirection: "right" | "down") => handleSplitPane(shell.pane_id, nextDirection)}
          contentStyle={trafficLightInsetStyle}
          titlePath={shortenPath(shell.cwd)}
        />
      );
    }

    if (content.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === content.paneId)
        ?? (pendingProcess?.pane_id === content.paneId ? pendingProcess : null);
      if (!proc) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span></div>;
      if (proc.pane_id.startsWith("_pending_")) {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); split.handleClosePane(leafId); }}>Back</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
            </div>
          </div>
        );
      }
      return (
        <DetectedProcessDetail
          process={proc} questions={questions}
          onBack={() => split.handleClosePane(leafId)}
          onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
          onEditFirstQuery={() => openEditProcessQueryDialog(proc, "first_query")}
          onEditLastQuery={() => openEditProcessQueryDialog(proc, "last_query")}
          autoYesActive={autoYes.autoYesPaneIds.has(proc.pane_id)}
          onToggleAutoYes={() => {
            const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
            if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
            else autoYes.handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
          }}
          showBackButton={!isWide} hidePath
          onStopped={() => {
            setStoppingProcesses((prev) => {
              if (prev.some((sp) => sp.process.pane_id === proc.pane_id)) return prev;
              return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
            });
            core.requestFastPoll(`pane:${proc.pane_id}`);
            split.handleClosePane(leafId);
          }}
          onFork={(direction: "right" | "down") => handleFork(proc.pane_id, direction)}
          onSplitPane={(direction: "right" | "down") => handleSplitPane(proc.pane_id, direction)}
          onInjectSecrets={() => setInjectSecretsPaneId(proc.pane_id)}
          onSearchSkills={() => setSkillSearchPaneId(proc.pane_id)}
          contentStyle={trafficLightInsetStyle}
          titlePath={buildProcessTitlePath(proc)}
        />
      );
    }

    const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
    if (!job) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span></div>;
    const jobQuestion = questions.find((q) => q.matched_job === job.slug);
    const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);
    return (
      <DesktopJobDetail
        transport={transport} job={job}
        status={core.statuses[job.slug] ?? { state: "idle" as const }}
        firstQuery={matchedProcess?.first_query ?? undefined}
        lastQuery={matchedProcess?.last_query ?? undefined}
        onEditFirstQuery={matchedProcess ? () => openEditProcessQueryDialog(matchedProcess, "first_query") : undefined}
        onEditLastQuery={matchedProcess ? () => openEditProcessQueryDialog(matchedProcess, "last_query") : undefined}
        onBack={() => split.handleClosePane(leafId)}
        onEdit={() => { setEditingJob(job); split.handleClosePane(leafId); }}
        onOpen={() => handleOpen(job.slug)}
        onToggle={() => { actions.toggleJob(job.slug); core.reload(); }}
        onDuplicate={(group: string) => handleDuplicate(job, group)}
        onDuplicateToFolder={() => handleDuplicateToFolder(job)}
        onDelete={() => { split.handleClosePane(leafId); actions.deleteJob(job.slug); core.reload(); }}
        groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
        showBackButton={!isWide} hidePath
        options={jobQuestion?.options}
        questionContext={jobQuestion?.context_lines}
        {...buildJobPaneActions(job, jobQuestion)}
        onStopping={() => {
          setStoppingJobSlugs((prev) => new Set(prev).add(job.slug));
          core.requestFastPoll(`job:${job.slug}`);
        }}
        contentStyle={trafficLightInsetStyle}
        titlePath={buildJobTitlePath(job, jobQuestion)}
      />
    );
  }, [agentJob, agentProcess, core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, handleSplitPane, questionPolling, buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath, split.handleClosePane, isWide, trafficLightInsetStyle, pendingProcess, shellPanes, openRenameProcessDialog]);

  // Custom card renderers for drag-and-drop
  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: string | boolean; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string }) => (
      <DraggableJobCard
        {...props}
        reorderEnabled={sortMode === "name"}
      />
    ),
    [sortMode],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: string | boolean; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string }) => (
      <DraggableProcessCard
        {...props}
        reorderEnabled
      />
    ),
    [],
  );

  const wrapSortableJobGroup = useCallback((group: string, jobSlugs: string[], children: React.ReactNode) => (
    <SortableContext
      key={`sortable-${group}`}
      items={jobSlugs}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  const wrapSortableProcessGroup = useCallback((group: string, processPaneIds: string[], children: React.ReactNode) => (
    <SortableContext
      key={`sortable-process-${group}`}
      items={processPaneIds}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  // --- Notification visibility ---

  const [nfnVisible, setNfnVisible] = useState(questions.length > 0);
  const nfnHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (questions.length > 0) {
      if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current);
      setNfnVisible(true);
    } else {
      nfnHideTimer.current = setTimeout(() => setNfnVisible(false), 500);
    }
    return () => { if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current); };
  }, [questions.length]);

  const notificationSection = useMemo(() => {
    if (!nfnVisible && autoYes.autoYesEntries.length === 0) return undefined;
    return (
      <>
        <AutoYesBanner entries={autoYes.autoYesEntries} onDisable={autoYes.handleDisableAutoYes} onPress={handleAutoYesPress} />
        {nfnVisible && (
          <NotificationSection
            questions={questions}
            resolveJob={questionPolling.resolveQuestionJob}
            onNavigate={handleQuestionNavigate}
            onSendOption={questionPolling.handleQuestionSendOption}
            collapsed={core.collapsedGroups.has("Notifications")}
            onToggleCollapse={() => core.toggleGroup("Notifications")}
            autoYesPaneIds={autoYes.autoYesPaneIds}
            onToggleAutoYes={autoYes.handleToggleAutoYes}
            wrapQuestionCard={isWide ? (question, card) => (
              <DraggableNotificationCard
                question={question}
                resolvedJob={questionPolling.resolveQuestionJob(question)}
              >
                {card}
              </DraggableNotificationCard>
            ) : undefined}
          />
        )}
      </>
    );
  }, [nfnVisible, questions, questionPolling, handleQuestionNavigate, core.collapsedGroups, core.toggleGroup, autoYes, handleAutoYesPress, isWide]);

  // --- Render ---

  const isEditorVisible = !!(editingJob || isCreating);
  const isPickerVisible = showPicker && !isEditorVisible;
  const isMainVisible = isWide || (!isEditorVisible && !isPickerVisible);
  const panelContentStyle: CSSProperties = {
    flex: 1,
    overflow: "auto",
    paddingTop: 28,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: isWide && sidebarCollapsed ? 104 : 20,
  };

  const renderSinglePaneContent = useCallback((content: PaneContent) => {
    if (content.kind === "agent") {
      return (
        <AgentDetail
          transport={transport}
          job={agentJob}
          status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => setViewingAgent(false)}
          onOpen={() => handleOpen("agent")}
          onEditTitle={agentProcess ? () => openRenameProcessDialog(agentProcess) : undefined}
          showBackButton={!isWide}
          hidePath
          contentStyle={trafficLightInsetStyle}
          titlePath={agentProcess ? buildProcessTitlePath(agentProcess) : "Agent"}
        />
      );
    }

    if (content.kind === "process") {
      const singleProcess = core.processes.find((p) => p.pane_id === content.paneId)
        ?? (pendingProcess?.pane_id === content.paneId ? pendingProcess : null);
      if (singleProcess && pendingProcess && singleProcess.pane_id === pendingProcess.pane_id
          && singleProcess.pane_id.startsWith("_pending_")) {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); setViewingProcess(null); }}>Back</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
            </div>
          </div>
        );
      }
      if (!singleProcess) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span>
          </div>
        );
      }
      return (
          <DetectedProcessDetail
            process={singleProcess} questions={questions}
            onBack={() => setViewingProcess(null)}
            onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
            onEditFirstQuery={() => openEditProcessQueryDialog(singleProcess, "first_query")}
            onEditLastQuery={() => openEditProcessQueryDialog(singleProcess, "last_query")}
            autoYesActive={autoYes.autoYesPaneIds.has(singleProcess.pane_id)}
            onToggleAutoYes={() => {
              const paneQuestion = questions.find((q) => q.pane_id === singleProcess.pane_id);
              if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
              else autoYes.handleToggleAutoYesByPaneId(singleProcess.pane_id, singleProcess.cwd.replace(/^\/Users\/[^/]+/, "~"));
            }}
            showBackButton={!isWide} hidePath
            onStopped={() => {
              setStoppingProcesses((prev) => {
                if (prev.some((sp) => sp.process.pane_id === singleProcess.pane_id)) return prev;
                return [...prev, { process: { ...singleProcess, _transient_state: "stopping" }, stoppedAt: Date.now() }];
              });
              core.requestFastPoll(`pane:${singleProcess.pane_id}`);
              selectAdjacentItem(singleProcess.pane_id);
            }}
            onFork={(direction: "right" | "down") => handleFork(singleProcess.pane_id, direction)}
            onSplitPane={(direction: "right" | "down") => handleSplitPane(singleProcess.pane_id, direction)}
            onInjectSecrets={() => setInjectSecretsPaneId(singleProcess.pane_id)}
            onSearchSkills={() => setSkillSearchPaneId(singleProcess.pane_id)}
            contentStyle={trafficLightInsetStyle}
            titlePath={buildProcessTitlePath(singleProcess)}
          />
      );
    }

    if (content.kind === "terminal") {
      const singleShell = shellPanes.find((p) => p.pane_id === content.paneId);
      if (!singleShell) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Shell pane not found</span>
          </div>
        );
      }
      return (
        <ShellPaneDetail
          shell={singleShell}
          onBack={() => setViewingShell(null)}
          showBackButton={!isWide}
          hidePath
          onStopped={() => {
            setShellPanes((prev) => prev.filter((p) => p.pane_id !== singleShell.pane_id));
            selectAdjacentItem(singleShell.pane_id);
          }}
          onSplitPane={(direction: "right" | "down") => handleSplitPane(singleShell.pane_id, direction)}
          contentStyle={trafficLightInsetStyle}
          titlePath={shortenPath(singleShell.cwd)}
        />
      );
    }

    if (content.kind === "job") {
      const singleJob = (core.jobs as Job[]).find((j) => j.slug === content.slug);
      if (!singleJob) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span>
          </div>
        );
      }
      const jobQuestion = questions.find((q) => q.matched_job === singleJob.slug);
      const matchedProcess = core.processes.find((p) => p.matched_job === singleJob.slug);
      return (
        <DesktopJobDetail
          transport={transport} job={singleJob}
          status={core.statuses[singleJob.slug] ?? { state: "idle" as const }}
          firstQuery={matchedProcess?.first_query ?? undefined}
          lastQuery={matchedProcess?.last_query ?? undefined}
          onEditFirstQuery={matchedProcess ? () => openEditProcessQueryDialog(matchedProcess, "first_query") : undefined}
          onEditLastQuery={matchedProcess ? () => openEditProcessQueryDialog(matchedProcess, "last_query") : undefined}
          onBack={() => setViewingJob(null)}
          onEdit={() => { setEditingJob(singleJob); setViewingJob(null); }}
          onOpen={() => handleOpen(singleJob.slug)}
          onToggle={() => { actions.toggleJob(singleJob.slug); core.reload(); }}
          onDuplicate={(group: string) => handleDuplicate(singleJob, group)}
          onDuplicateToFolder={() => handleDuplicateToFolder(singleJob)}
          onDelete={() => { const slug = singleJob.slug; selectAdjacentItem(slug); actions.deleteJob(slug); core.reload(); }}
          groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
          showBackButton={!isWide} hidePath
          options={jobQuestion?.options}
          questionContext={jobQuestion?.context_lines}
          {...buildJobPaneActions(singleJob, jobQuestion)}
          onStopping={() => {
            setStoppingJobSlugs((prev) => new Set(prev).add(singleJob.slug));
            core.requestFastPoll(`job:${singleJob.slug}`);
          }}
          contentStyle={trafficLightInsetStyle}
          titlePath={buildJobTitlePath(singleJob, jobQuestion)}
        />
      );
    }

    return (
      <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Select a job to view details</span>
      </div>
    );
  }, [agentJob, agentProcess, core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, handleSplitPane, questionPolling, buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath, isWide, trafficLightInsetStyle, pendingProcess, shellPanes, selectAdjacentItem, openRenameProcessDialog]);

  const detailPane = currentContent ? (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      {shouldCacheSinglePaneContent(currentContent) ? (
        recentSinglePaneContents.map((content) => {
          const key = paneContentCacheKey(content);
          const isActive = paneContentCacheKey(currentContent) === key;
          return (
            <div
              key={key}
              style={{
                display: isActive ? "flex" : "none",
                flexDirection: "column",
                position: "absolute",
                inset: 0,
                overflow: "hidden",
              }}
            >
              {renderSinglePaneContent(content)}
            </div>
          );
        })
      ) : (
        <div
          key={paneContentCacheKey(currentContent)}
          style={{
            display: "flex",
            flexDirection: "column",
            position: "absolute",
            inset: 0,
            overflow: "hidden",
          }}
        >
          {renderSinglePaneContent(currentContent)}
        </div>
      )}
      {paramsDialog && currentContent.kind === "job" && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}
      {autoYes.pendingAutoYes && (currentContent.kind === "job" || currentContent.kind === "process") && (
        <ConfirmDialog
          message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
          confirmLabel="Enable" confirmClassName="btn btn-sm"
        />
      )}
    </div>
  ) : (
    <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
      <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Select a job to view details</span>
    </div>
  );

  const dialogs = (
    <>
      {paramsDialog && !viewingJob && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}

      {autoYes.pendingAutoYes && !viewingJob && !viewingProcess && (
        <ConfirmDialog
          message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
          confirmLabel="Enable" confirmClassName="btn btn-sm"
        />
      )}

      {importJob.importState?.step === "pick-dest" && (
        <ConfirmDialog
          message={`"${importJob.importState.jobName}" was not auto-detected. Select a project folder to import into.`}
          onConfirm={importJob.handleImportPickDest} onCancel={() => importJob.setImportState(null)}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importJob.importState?.step === "confirm-duplicate" && (
        <ConfirmDialog
          message={`"${importJob.importState.jobName}" already exists in this project. Duplicate to a different project?`}
          onConfirm={importJob.handleImportDuplicate} onCancel={() => importJob.setImportState(null)}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importJob.importError && (
        <ConfirmDialog
          message={importJob.importError}
          onConfirm={() => importJob.setImportError(null)} onCancel={() => importJob.setImportError(null)}
          confirmLabel="OK" confirmClassName="btn btn-sm"
        />
      )}

      {missedCronJobs.length > 0 && (
        <ConfirmDialog
          message={`${missedCronJobs.length} missed cron job${missedCronJobs.length > 1 ? "s" : ""} detected:\n\n${missedCronJobs.map((n) => "  - " + n).join("\n")}\n\nRun them now?`}
          onConfirm={handleRunMissedJobs} onCancel={() => setMissedCronJobs([])}
          confirmLabel="Run All" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {skillSearchPaneId && (
        <SkillSearchDialog
          onSelect={(name) => {
            invoke("send_detected_process_input", { paneId: skillSearchPaneId, text: "/" + name }).catch(console.error);
            setSkillSearchPaneId(null);
          }}
          onCancel={() => setSkillSearchPaneId(null)}
        />
      )}

      {injectSecretsPaneId && (
        <InjectSecretsDialog
          onConfirm={(keys) => {
            handleForkWithSecrets(injectSecretsPaneId, keys);
            setInjectSecretsPaneId(null);
          }}
          onCancel={() => setInjectSecretsPaneId(null)}
        />
      )}

      {editProcessField && (
        <EditTextDialog
          title={editProcessField.title}
          label={editProcessField.label}
          initialValue={editProcessField.initialValue}
          placeholder={editProcessField.placeholder}
          onSave={handleSaveProcessField}
          onCancel={() => setEditProcessField(null)}
        />
      )}
    </>
  );

  const detectedProcessesMemo = useMemo(() => {
    const stoppingIds = new Set(stoppingProcesses.map((sp) => sp.process.pane_id));
    const base = stoppingIds.size > 0
      ? core.processes.filter((p) => !stoppingIds.has(p.pane_id))
      : core.processes;
    const extras = [
      ...stoppingProcesses.map((sp) => sp.process),
      ...(pendingProcess ? [pendingProcess] : []),
    ];
    return extras.length > 0 ? [...base, ...extras] : base;
  }, [stoppingProcesses, core.processes, pendingProcess]);

  const jobListView = (
    <JobListView
      jobs={core.jobs}
      statuses={core.statuses}
      detectedProcesses={detectedProcessesMemo}
      shellPanes={shellPanes}
      collapsedGroups={core.collapsedGroups}
      onToggleGroup={core.toggleGroup}
      groupOrder={groupOrder}
      jobOrder={jobOrder}
      processOrder={processOrder}
      sortMode={sortMode}
      onSortChange={setSortMode}
      onSelectJob={handleSelectJob}
      onSelectProcess={handleSelectProcess}
      onSelectShell={handleSelectShell}
      selectedItems={split.selectedItems}
      focusedItemKey={split.focusedItemKey}
      onRunAgent={handleRunAgent}
      getAgentProviders={handleGetAgentProviders}
      onAddJob={handleAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={handleHideGroup}
      onUnhideGroup={handleUnhideGroup}
      headerContent={notificationSection}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={scrollToSlug}
      scrollEnabled={!split.isDragging}
      onSelectableItemsChange={setSidebarSelectableItems}
      sidebarFocusRef={sidebarFocusRef}
      onStopJob={(slug) => {
        setStoppingJobSlugs((prev) => new Set(prev).add(slug));
        core.requestFastPoll(`job:${slug}`);
        transport.stopJob(slug);
      }}
      onStopProcess={(paneId) => {
        const proc = core.processes.find((p) => p.pane_id === paneId);
        if (proc) {
          setStoppingProcesses((prev) => {
            if (prev.some((sp) => sp.process.pane_id === paneId)) return prev;
            return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
          });
        }
        core.requestFastPoll(`pane:${paneId}`);
        invoke("stop_detected_process", { paneId });
      }}
      onRenameProcess={openRenameProcessDialog}
      onSaveProcessName={handleSaveProcessNameInline}
      onStopShell={(paneId) => {
        setShellPanes((prev) => prev.filter((p) => p.pane_id !== paneId));
        if (viewingShell?.pane_id === paneId) selectAdjacentItem(paneId);
        invoke("stop_detected_process", { paneId });
      }}
      autoYesPaneIds={autoYes.autoYesPaneIds}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
      wrapJobGroup={isWide && sortMode === "name" ? wrapSortableJobGroup : undefined}
      wrapProcessGroup={isWide ? wrapSortableProcessGroup : undefined}
      stoppingSlugs={stoppingJobSlugs}
    />
  );

  const dragOverlayContent = (() => {
    const data = split.dragOverlayData as DragData | null;
    if (!data) return null;
    return (
      <div style={{ opacity: 0.8, pointerEvents: "none", width: 300 }}>
        {data.kind === "job" ? (
          (() => {
            const status = core.statuses[data.slug] ?? { state: "idle" as const };
            return status.state === "running"
              ? <RunningJobCard job={data.job} status={status} />
              : <JobCard job={data.job} status={status} />;
          })()
        ) : data.question ? (
          <NotificationCard
            question={data.question}
            resolvedJob={data.resolvedJob ?? null}
            onNavigate={() => {}}
            onSendOption={() => {}}
            autoYesActive={autoYes.autoYesPaneIds.has(data.paneId)}
          />
        ) : data.process ? (
          <ProcessCard process={data.process} />
        ) : null}
      </div>
    );
  })();

  const dropOverlay = split.isDragging ? (
    <DropZoneOverlay
      tree={split.effectiveTreeForOverlay}
      containerW={split.detailSize.w}
      containerH={split.detailSize.h}
      activeZone={split.dragActiveZone}
    />
  ) : null;

  return (
    <>
      {/* Editor view - full screen only on narrow layouts */}
      <div style={{ display: !isWide && isEditorVisible ? undefined : "none", height: "100%" }}>
        {saveError && (
          <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
            Save failed: {saveError}
          </div>
        )}
        {!isWide && isEditorVisible && (
          <div style={panelContentStyle}>
            <JobEditor
              job={editingJob}
              onSave={handleSave}
              onCancel={() => {
                if (editingJob) setViewingJob(editingJob);
                setEditingJob(null); setIsCreating(false); setCreateForGroup(null); setSaveError(null);
              }}
              headerMode="back"
              onPickTemplate={(templateId) => {
                setIsCreating(false); setCreateForGroup(null);
                setPickerTemplateId(templateId); setShowPicker(true);
              }}
              defaultGroup={createForGroup?.group}
              defaultFolderPath={createForGroup?.folderPath ?? undefined}
            />
          </div>
        )}
      </div>

      {/* Picker view - full screen only on narrow layouts */}
      <div style={{ display: !isWide && isPickerVisible ? undefined : "none", height: "100%" }}>
        {!isWide && isPickerVisible && (
          <div style={panelContentStyle}>
            <SamplePicker
              autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
              headerMode="back"
              onCreated={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.(); core.reload();
              }}
              onBlank={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.(); setIsCreating(true);
              }}
              onCancel={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.();
              }}
            />
          </div>
        )}
      </div>

      {/* Main view */}
      <div style={{ display: isMainVisible ? undefined : "none", height: "100%" }}>
        {!isWide ? (
          (viewingAgent || pendingAgentWorkDir || viewingProcess || viewingShell || viewingJob) ? (
            <div style={{ height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              {navBar}
              {detailPane}
              {dialogs}
            </div>
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {navBar}
              {jobListView}
              {dialogs}
            </div>
          )
        ) : (
          <DndContext
            sensors={split.sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div style={{ display: "flex", flexDirection: "row", height: "100%", overflow: "hidden" }}>
              {!sidebarCollapsed && (
                <>
                  <div style={{ width: listWidth, minWidth: 260, maxWidth: 600, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    {navBar}
                    {jobListView}
                  </div>
                  <div onMouseDown={onResizeHandleMouseDown} style={{ width: 9, backgroundColor: "transparent", marginLeft: -5, marginRight: -4, zIndex: 10, cursor: "col-resize", flexShrink: 0, position: "relative" }} />
                </>
              )}
              <div ref={split.detailPaneRef} className="detail-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)", position: "relative" }}>
                {isEditorVisible ? (
                  <div style={panelContentStyle}>
                    {saveError && (
                      <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
                        Save failed: {saveError}
                      </div>
                    )}
                    <JobEditor
                      job={editingJob}
                      onSave={handleSave}
                      onCancel={() => {
                        if (editingJob) setViewingJob(editingJob);
                        setEditingJob(null); setIsCreating(false); setCreateForGroup(null); setSaveError(null);
                      }}
                      headerMode="close"
                      onPickTemplate={(templateId) => {
                        setIsCreating(false); setCreateForGroup(null);
                        setPickerTemplateId(templateId); setShowPicker(true);
                      }}
                      defaultGroup={createForGroup?.group}
                      defaultFolderPath={createForGroup?.folderPath ?? undefined}
                    />
                  </div>
                ) : isPickerVisible ? (
                  <div style={panelContentStyle}>
                    <SamplePicker
                      autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
                      headerMode="close"
                      onCreated={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.(); core.reload();
                      }}
                      onBlank={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.(); setIsCreating(true);
                      }}
                      onCancel={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.();
                      }}
                    />
                  </div>
                ) : (
                  <SplitDetailArea
                    tree={split.tree}
                    renderLeaf={renderLeaf}
                    onRatioChange={split.handleSplitRatioChange}
                    onFocusLeaf={split.setFocusedLeafId}
                    focusedLeafId={split.focusedLeafId}
                    paneColors={split.paneColors}
                    minPaneSize={200}
                    emptyContent={detailPane}
                    overlay={dropOverlay}
                  />
                )}
                {rightPanelOverlay}
              </div>
              {dialogs}
            </div>
            <DragOverlay dropAnimation={null}>{dragOverlayContent}</DragOverlay>
          </DndContext>
        )}
      </div>
    </>
  );
}
