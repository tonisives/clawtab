import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { RemoteJob, JobSortMode, JobStatus } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import {
  JobListView,
  NotificationSection,
  AutoYesBanner,
  SplitDetailArea,
  DropZoneOverlay,
  JobCard,
  RunningJobCard,
  ProcessCard,
  useJobsCore,
  useJobActions,
  useSplitTree,
  collectLeaves,
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
import { DraggableJobCard, DraggableProcessCard, type DragData } from "./DraggableCards";
import { SkillSearchDialog } from "./SkillSearchDialog";
import { InjectSecretsDialog } from "./InjectSecretsDialog";
import { XtermPane } from "./XtermPane";
import { useQuestionPolling } from "../hooks/useQuestionPolling";
import { useAutoYes } from "../hooks/useAutoYes";
import { useImportJob } from "../hooks/useImportJob";

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

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled, navBar, rightPanelOverlay, onJobSelected }: JobsTabProps) {
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<JobSortMode>("name");

  // Navigation state
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTemplateId, setPickerTemplateId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewingJob, setViewingJob] = useState<Job | null>(null);
  const [viewingProcess, setViewingProcess] = useState<ClaudeProcess | null>(null);
  const [createForGroup, setCreateForGroup] = useState<{ group: string; folderPath: string | null } | null>(null);
  const [viewingAgent, setViewingAgent] = useState(false);
  const [paramsDialog, setParamsDialog] = useState<{ job: Job; values: Record<string, string> } | null>(null);
  const [pendingAgentWorkDir, setPendingAgentWorkDir] = useState<{ dir: string; startedAt: number } | null>(null);
  const [scrollToSlug, setScrollToSlug] = useState<string | null>(null);
  const [pendingProcess, setPendingProcess] = useState<ClaudeProcess | null>(null);
  const [stoppingProcesses, setStoppingProcesses] = useState<{ process: ClaudeProcess; stoppedAt: number }[]>([]);
  const [stoppingJobSlugs, setStoppingJobSlugs] = useState<Set<string>>(new Set());

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

  const handleSelectJobDirect = useCallback((job: RemoteJob) => {
    setViewingProcess(null);
    setViewingAgent(false);
    setViewingJob(job as Job);
    onJobSelected?.();
  }, [onJobSelected]);

  const handleSelectProcessDirect = useCallback((process: ClaudeProcess) => {
    setViewingJob(null);
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingProcess(null);
      setViewingAgent(true);
      onJobSelected?.();
      return;
    }
    setViewingAgent(false);
    setViewingProcess(process);
    onJobSelected?.();
  }, [onJobSelected]);

  // Compute current single-pane content for the split tree hook
  const currentContent: PaneContent | null = useMemo(() => {
    if (viewingAgent) return { kind: "agent" };
    if (viewingProcess) return { kind: "process", paneId: viewingProcess.pane_id };
    if (viewingJob) return { kind: "job", slug: viewingJob.slug };
    return null;
  }, [viewingAgent, viewingProcess, viewingJob]);

  const split = useSplitTree({
    storageKey: "desktop_split_tree",
    minPaneSize: 200,
    onCollapse: useCallback((content: PaneContent) => {
      if (content.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === content.slug);
        if (job) { setViewingJob(job); setViewingProcess(null); setViewingAgent(false); }
      } else if (content.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === content.paneId);
        if (proc) { setViewingProcess(proc); setViewingJob(null); setViewingAgent(false); }
      } else if (content.kind === "agent") {
        setViewingAgent(true); setViewingJob(null); setViewingProcess(null);
      }
    }, [core.jobs, core.processes]),
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

  // Wrap select handlers to check tree first
  const handleSelectJob = useCallback((job: RemoteJob) => {
    const content: PaneContent = { kind: "job", slug: job.slug };
    if (split.tree && split.handleSelectInTree(content)) return;
    handleSelectJobDirect(job);
  }, [split.tree, split.handleSelectInTree, handleSelectJobDirect]);

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
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
      const newPaneId = await invoke<string>("split_pane_plain", { paneId, direction });
      await core.reload();
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => (l.content.kind === "process" || l.content.kind === "terminal") && l.content.paneId === paneId);
      if (sourceLeaf) {
        const sourceProc = core.processes.find(p => p.pane_id === paneId);
        const tmuxSession = sourceProc?.tmux_session
          ?? (sourceLeaf.content.kind === "terminal" ? sourceLeaf.content.tmuxSession : "");
        split.addSplitLeaf(sourceLeaf.id, { kind: "terminal", paneId: newPaneId, tmuxSession }, treeDirection);
      }
    } catch (e) {
      console.error("split_pane_plain failed:", e);
    }
  }, [core.reload, split.tree, split.addSplitLeaf, core.processes]);

  // --- Settings & event listeners ---

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (s.group_order && s.group_order.length > 0) {
        setGroupOrder(s.group_order);
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
      if (!fresh) setViewingProcess(null);
      else if (fresh !== viewingProcess) setViewingProcess(fresh);
    }
  }, [core.processes, viewingProcess]);

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
      setViewingProcess(match);
      setScrollToSlug(match.pane_id);
      return;
    }
    if (Date.now() - startedAt > 15000) {
      setPendingAgentWorkDir(null);
      setPendingProcess(null);
    }
  }, [core.processes, pendingAgentWorkDir, pendingProcess]);

  useEffect(() => {
    if (stoppingProcesses.length === 0) return;
    setStoppingProcesses((prev) =>
      prev.filter((sp) => {
        const stillPresent = core.processes.some((p) => p.pane_id === sp.process.pane_id);
        return stillPresent && Date.now() - sp.stoppedAt < 10000;
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+E: toggle sidebar
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        setSidebarCollapsed(prev => !prev);
        return;
      }

      // Ctrl+V: split focused pane vertically (side by side)
      if (e.ctrlKey && e.key === "v") {
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

      // Ctrl+S: split focused pane horizontally (top/bottom)
      if (e.ctrlKey && e.key === "s") {
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

      // Cmd+H/J/K/L: navigate between panes
      if (e.metaKey && "hjkl".includes(e.key)) {
        e.preventDefault();
        const tree = split.tree;
        if (!tree) return;
        const leaves = collectLeaves(tree);
        if (leaves.length < 2) return;
        const currentIdx = leaves.findIndex(l => l.id === split.focusedLeafId);
        const idx = currentIdx === -1 ? 0 : currentIdx;
        let next = idx;
        if (e.key === "h" || e.key === "k") {
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
  }, [split.tree, split.focusedLeafId, split.setFocusedLeafId, handleSplitPane]);

  const isFullScreenView = !!(editingJob || isCreating || showPicker);
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
      await core.reload();
      setEditingJob(null);
      setIsCreating(false);
      if (wasEditing) setViewingJob(job);
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

  type ListItemRef = { kind: "job"; slug: string; job: Job } | { kind: "process"; paneId: string; process: ClaudeProcess };
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
      for (const [, gJobs] of grouped) gJobs.sort((a, b) => a.name.localeCompare(b.name));
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
    return result;
  }, [core.jobs, core.processes, sortMode, pendingProcess, stoppingProcesses]);

  const selectAdjacentItem = useCallback((currentId: string) => {
    const idx = orderedItems.findIndex((it) =>
      it.kind === "job" ? it.slug === currentId : it.paneId === currentId,
    );
    const prevIdx = idx > 0 ? idx - 1 : (orderedItems.length > 1 ? 1 : -1);
    if (prevIdx >= 0 && prevIdx < orderedItems.length) {
      const next = orderedItems[prevIdx];
      if (next.kind === "job") {
        setViewingProcess(null); setViewingAgent(false); setViewingJob(next.job); setScrollToSlug(next.slug);
      } else {
        setViewingJob(null); setViewingAgent(false); setViewingProcess(next.process); setScrollToSlug(next.paneId);
      }
    } else {
      setViewingJob(null); setViewingProcess(null);
    }
  }, [orderedItems]);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string) => {
    if (workDir) {
      const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
      const matchedGroup = matchingJob ? (matchingJob.group || "default") : null;
      // Show a placeholder while waiting for the pane to be created
      const placeholder: ClaudeProcess = {
        pane_id: `_pending_${Date.now()}`, cwd: workDir, version: "", tmux_session: "", window_name: "",
        matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
        last_query: null, session_started_at: new Date().toISOString(), _transient_state: "starting",
      };
      setPendingProcess(placeholder);
      setViewingJob(null); setViewingAgent(false); setViewingProcess(placeholder);
      setScrollToSlug(placeholder.pane_id);

      const result = await actions.runAgent(prompt, workDir);
      if (result) {
        // Got the real pane - switch to it immediately
        const realProcess: ClaudeProcess = {
          pane_id: result.pane_id, cwd: workDir, version: "", tmux_session: result.tmux_session, window_name: "",
          matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
          last_query: null, session_started_at: new Date().toISOString(),
        };
        setPendingProcess(realProcess);
        setViewingProcess(realProcess);
        setScrollToSlug(result.pane_id);
        // Clear pending state after next process poll picks it up
        setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      } else {
        // Fallback: poll for the process (timeout case)
        setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      }
    } else {
      await actions.runAgent(prompt, workDir);
    }
  }, [actions, core.jobs]);

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
    const isFolderGroup = groupJobs.length > 0 && groupJobs.every((j) => j.job_type === "folder");
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
        return !core.processes.find(p => p.pane_id === content.paneId);
      }
      return false;
    });
  }, [core.processes, core.loaded, split.cleanStaleLeaves]);

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

  // Render a leaf pane in the split tree
  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    if (content.kind === "agent") {
      const agentJob: RemoteJob = { name: "agent", job_type: "claude", enabled: true, cron: "", group: "", slug: "agent" };
      return (
        <AgentDetail transport={transport} job={agentJob} status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => split.handleClosePane(leafId)} onOpen={() => handleOpen("agent")} showBackButton={!isWide} hidePath />
      );
    }

    if (content.kind === "terminal") {
      return (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", overflow: "hidden" }}>
          <XtermPane
            paneId={content.paneId}
            tmuxSession={content.tmuxSession}
            group="default"
            onExit={() => split.handleClosePane(leafId)}
          />
        </div>
      );
    }

    if (content.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === content.paneId);
      if (!proc) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span></div>;
      return (
        <DetectedProcessDetail
          process={proc} questions={questions}
          onBack={() => split.handleClosePane(leafId)}
          onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
          autoYesActive={autoYes.autoYesPaneIds.has(proc.pane_id)}
          onToggleAutoYes={() => {
            const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
            if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
            else autoYes.handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
          }}
          showBackButton={!isWide} hidePath
          onStopped={() => {
            setStoppingProcesses((prev) => [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }]);
            split.handleClosePane(leafId);
          }}
          onFork={(direction: "right" | "down") => handleFork(proc.pane_id, direction)}
          onSplitPane={(direction: "right" | "down") => handleSplitPane(proc.pane_id, direction)}
          onInjectSecrets={() => setInjectSecretsPaneId(proc.pane_id)}
          onSearchSkills={() => setSkillSearchPaneId(proc.pane_id)}
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
        onStopping={() => setStoppingJobSlugs((prev) => new Set(prev).add(job.slug))}
      />
    );
  }, [core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, handleSplitPane, questionPolling, buildJobPaneActions, split.handleClosePane]);

  // Custom card renderers for drag-and-drop
  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: string | boolean; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean }) => <DraggableJobCard {...props} />,
    [],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: string | boolean; onStop?: () => void; autoYesActive?: boolean }) => <DraggableProcessCard {...props} />,
    [],
  );

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
          />
        )}
      </>
    );
  }, [nfnVisible, questions, questionPolling, handleQuestionNavigate, core.collapsedGroups, core.toggleGroup, autoYes, handleAutoYesPress]);

  // --- Render ---

  const isEditorVisible = !!(editingJob || isCreating);
  const isPickerVisible = showPicker && !isEditorVisible;
  const isMainVisible = !isEditorVisible && !isPickerVisible;

  const detailPane = (() => {
    if (viewingAgent) {
      const agentJob: RemoteJob = { name: "agent", job_type: "claude", enabled: true, cron: "", group: "", slug: "agent" };
      return (
        <AgentDetail transport={transport} job={agentJob} status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => setViewingAgent(false)} onOpen={() => handleOpen("agent")} showBackButton={!isWide} hidePath />
      );
    }

    if (viewingProcess && pendingProcess && viewingProcess.pane_id === pendingProcess.pane_id
        && viewingProcess.pane_id.startsWith("_pending_")) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); setViewingProcess(null); }}>Back</button>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
          </div>
        </div>
      );
    }

    if (viewingProcess) {
      return (
        <>
          <DetectedProcessDetail
            process={viewingProcess} questions={questions}
            onBack={() => setViewingProcess(null)}
            onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
            autoYesActive={autoYes.autoYesPaneIds.has(viewingProcess.pane_id)}
            onToggleAutoYes={() => {
              const paneQuestion = questions.find((q) => q.pane_id === viewingProcess.pane_id);
              if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
              else autoYes.handleToggleAutoYesByPaneId(viewingProcess.pane_id, viewingProcess.cwd.replace(/^\/Users\/[^/]+/, "~"));
            }}
            showBackButton={!isWide} hidePath
            onStopped={() => {
              setStoppingProcesses((prev) => [...prev, { process: { ...viewingProcess, _transient_state: "stopping" }, stoppedAt: Date.now() }]);
              selectAdjacentItem(viewingProcess.pane_id);
            }}
            onFork={(direction: "right" | "down") => handleFork(viewingProcess.pane_id, direction)}
            onSplitPane={(direction: "right" | "down") => handleSplitPane(viewingProcess.pane_id, direction)}
            onInjectSecrets={() => setInjectSecretsPaneId(viewingProcess.pane_id)}
            onSearchSkills={() => setSkillSearchPaneId(viewingProcess.pane_id)}
          />
          {autoYes.pendingAutoYes && (
            <ConfirmDialog
              message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
              onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
              confirmLabel="Enable" confirmClassName="btn btn-sm"
            />
          )}
        </>
      );
    }

    if (viewingJob) {
      const jobQuestion = questions.find((q) => q.matched_job === viewingJob.slug);
      const matchedProcess = core.processes.find((p) => p.matched_job === viewingJob.slug);
      return (
        <>
          <DesktopJobDetail
            transport={transport} job={viewingJob}
            status={core.statuses[viewingJob.slug] ?? { state: "idle" as const }}
            firstQuery={matchedProcess?.first_query ?? undefined}
            lastQuery={matchedProcess?.last_query ?? undefined}
            onBack={() => setViewingJob(null)}
            onEdit={() => { setEditingJob(viewingJob); setViewingJob(null); }}
            onOpen={() => handleOpen(viewingJob.slug)}
            onToggle={() => { actions.toggleJob(viewingJob.slug); core.reload(); }}
            onDuplicate={(group: string) => handleDuplicate(viewingJob, group)}
            onDuplicateToFolder={() => handleDuplicateToFolder(viewingJob)}
            onDelete={() => { const slug = viewingJob.slug; selectAdjacentItem(slug); actions.deleteJob(slug); core.reload(); }}
            groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
            showBackButton={!isWide} hidePath
            options={jobQuestion?.options}
            questionContext={jobQuestion?.context_lines}
            {...buildJobPaneActions(viewingJob, jobQuestion)}
            onStopping={() => setStoppingJobSlugs((prev) => new Set(prev).add(viewingJob.slug))}
          />
          {paramsDialog && (
            <ParamsOverlay
              job={paramsDialog.job} values={paramsDialog.values}
              onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
              onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
            />
          )}
          {autoYes.pendingAutoYes && (
            <ConfirmDialog
              message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
              onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
              confirmLabel="Enable" confirmClassName="btn btn-sm"
            />
          )}
        </>
      );
    }

    return (
      <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Select a job to view details</span>
      </div>
    );
  })();

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
      collapsedGroups={core.collapsedGroups}
      onToggleGroup={core.toggleGroup}
      groupOrder={groupOrder}
      sortMode={sortMode}
      onSortChange={setSortMode}
      onSelectJob={handleSelectJob}
      onSelectProcess={handleSelectProcess}
      selectedItems={split.selectedItems}
      focusedItemKey={split.focusedItemKey}
      onRunAgent={handleRunAgent}
      onAddJob={handleAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={handleHideGroup}
      onUnhideGroup={handleUnhideGroup}
      headerContent={notificationSection}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={scrollToSlug}
      scrollEnabled={!split.isDragging}
      onStopJob={(slug) => {
        setStoppingJobSlugs((prev) => new Set(prev).add(slug));
        transport.sigintJob ? transport.sigintJob(slug) : transport.stopJob(slug);
      }}
      onStopProcess={(paneId) => invoke("sigint_detected_process", { paneId })}
      autoYesPaneIds={autoYes.autoYesPaneIds}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
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
              ? <RunningJobCard jobName={data.job.name} status={status} />
              : <JobCard job={data.job} status={status} />;
          })()
        ) : (
          <ProcessCard process={data.process} />
        )}
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
      {/* Editor view - always in tree, hidden via display */}
      <div style={{ display: isEditorVisible ? undefined : "none", height: "100%" }}>
        {saveError && (
          <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
            Save failed: {saveError}
          </div>
        )}
        {isEditorVisible && (
          <JobEditor
            job={editingJob}
            onSave={handleSave}
            onCancel={() => {
              if (editingJob) setViewingJob(editingJob);
              setEditingJob(null); setIsCreating(false); setCreateForGroup(null); setSaveError(null);
            }}
            onPickTemplate={(templateId) => {
              setIsCreating(false); setCreateForGroup(null);
              setPickerTemplateId(templateId); setShowPicker(true);
            }}
            defaultGroup={createForGroup?.group}
            defaultFolderPath={createForGroup?.folderPath ?? undefined}
          />
        )}
      </div>

      {/* Picker view */}
      <div style={{ display: isPickerVisible ? undefined : "none", height: "100%" }}>
        {isPickerVisible && (
          <SamplePicker
            autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
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
        )}
      </div>

      {/* Main view */}
      <div style={{ display: isMainVisible ? undefined : "none", height: "100%" }}>
        {!isWide ? (
          (viewingAgent || pendingAgentWorkDir || viewingProcess || viewingJob) ? (
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
            onDragStart={split.handleDragStart}
            onDragMove={split.handleDragMove}
            onDragEnd={split.handleDragEnd}
            onDragCancel={split.handleDragCancel}
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
