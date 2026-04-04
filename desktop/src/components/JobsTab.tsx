import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type DragMoveEvent } from "@dnd-kit/core";
import type { RemoteJob, JobSortMode, JobStatus } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import {
  JobListView,
  NotificationSection,
  AutoYesBanner,
  SplitDetailArea,
  DropZoneOverlay,
  computeDropZone,
  JobCard,
  RunningJobCard,
  ProcessCard,
  useJobsCore,
  useJobActions,
} from "@clawtab/shared";
import type { AutoYesEntry, SplitDirection, DropZoneId } from "@clawtab/shared";
import { createTauriTransport } from "../transport/tauriTransport";
import type { AppSettings, Job } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetectedProcessDetail } from "./DetectedProcessDetail";
import { DesktopJobDetail, AgentDetail } from "./JobDetailSections";
import { ParamsOverlay } from "./ParamsOverlay";
import { DraggableJobCard, DraggableProcessCard, type DragData } from "./DraggableCards";

const transport = createTauriTransport();

interface JobsTabProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
  importCwtKey?: number;
  pendingPaneId?: string | null;
  onPaneHandled?: () => void;
}

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled }: JobsTabProps) {
  const core = useJobsCore(transport);
  const actions = useJobActions(transport, core.reloadStatuses);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
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

  // Split pane state
  type SplitItem = { kind: "job"; slug: string } | { kind: "process"; paneId: string } | { kind: "agent" };
  const [splitItem, setSplitItem] = useState<SplitItem | null>(null);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>(() => {
    return (localStorage.getItem("split_direction") as SplitDirection) || "horizontal";
  });
  const [splitRatio, setSplitRatio] = useState(() => {
    const v = localStorage.getItem("split_ratio");
    return v ? Math.max(0.2, Math.min(0.8, parseFloat(v))) : 0.5;
  });

  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null);
  const [dragOverlayData, setDragOverlayData] = useState<DragData | null>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Question polling
  const [questions, setQuestions] = useState<ClaudeQuestion[]>([]);
  const questionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedRef = useRef<Map<string, number>>(new Map());

  // Auto-yes state
  const [autoYesPaneIds, setAutoYesPaneIds] = useState<Set<string>>(new Set());
  const [pendingAutoYes, setPendingAutoYes] = useState<{ paneId: string; title: string } | null>(null);

  // Missed cron jobs
  const [missedCronJobs, setMissedCronJobs] = useState<string[]>([]);

  // --- Question polling ---

  const loadQuestions = useCallback(() => {
    invoke<ClaudeQuestion[]>("get_active_questions").then((qs) => {
      console.log("[nfn] loadQuestions got", qs.length, "questions");
      const now = Date.now();
      for (const [id, ts] of dismissedRef.current) {
        if (now - ts > 10000) dismissedRef.current.delete(id);
      }
      setQuestions(qs.filter((q) => !dismissedRef.current.has(q.question_id)));
    }).catch((e) => { console.error("[nfn] loadQuestions error", e); });
    // Sync auto-yes panes (backend prunes stale panes when Claude instances stop)
    invoke<string[]>("get_auto_yes_panes").then((paneIds) => {
      setAutoYesPaneIds(new Set(paneIds));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    console.log("[nfn] mounting, calling loadQuestions immediately");
    loadQuestions();
    questionPollRef.current = setInterval(loadQuestions, 5000);
    return () => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    };
  }, [loadQuestions]);

  const startFastQuestionPoll = useCallback(() => {
    if (questionPollRef.current) clearInterval(questionPollRef.current);
    if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    questionPollRef.current = setInterval(loadQuestions, 500);
    fastPollTimerRef.current = setTimeout(() => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      questionPollRef.current = setInterval(loadQuestions, 5000);
    }, 5000);
  }, [loadQuestions]);

  // --- Auto-yes ---

  useEffect(() => {
    invoke<string[]>("get_auto_yes_panes").then((paneIds) => {
      setAutoYesPaneIds(new Set(paneIds));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("auto-yes-changed", () => {
      invoke<string[]>("get_auto_yes_panes").then((paneIds) => {
        setAutoYesPaneIds(new Set(paneIds));
      }).catch(() => {});
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  const handleToggleAutoYes = useCallback((q: ClaudeQuestion) => {
    if (autoYesPaneIds.has(q.pane_id)) {
      const next = new Set(autoYesPaneIds);
      next.delete(q.pane_id);
      setAutoYesPaneIds(next);
      invoke("set_auto_yes_panes", { paneIds: [...next] }).catch(() => {});
      return;
    }
    const title = q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~");
    setPendingAutoYes({ paneId: q.pane_id, title });
  }, [autoYesPaneIds]);

  const confirmAutoYes = useCallback(() => {
    if (!pendingAutoYes) return;
    const next = new Set(autoYesPaneIds);
    next.add(pendingAutoYes.paneId);
    setAutoYesPaneIds(next);
    invoke("set_auto_yes_panes", { paneIds: [...next] }).catch(() => {});
    startFastQuestionPoll();
    setPendingAutoYes(null);
  }, [pendingAutoYes, autoYesPaneIds, startFastQuestionPoll]);

  const handleToggleAutoYesByPaneId = useCallback((paneId: string, title: string) => {
    if (autoYesPaneIds.has(paneId)) {
      const next = new Set(autoYesPaneIds);
      next.delete(paneId);
      setAutoYesPaneIds(next);
      invoke("set_auto_yes_panes", { paneIds: [...next] }).catch(() => {});
      return;
    }
    setPendingAutoYes({ paneId, title });
  }, [autoYesPaneIds]);

  const handleAutoYesPress = useCallback((entry: AutoYesEntry) => {
    if (entry.jobSlug) {
      const job = (core.jobs as Job[]).find((j) => j.slug === entry.jobSlug);
      if (job) { setViewingJob(job); return; }
    }
    const proc = core.processes.find((p) => p.pane_id === entry.paneId);
    if (proc) { setViewingProcess(proc); return; }
    // No job or detected process found - try focusing the tmux pane via a matching question
    const q = questions.find((q) => q.pane_id === entry.paneId);
    if (q) {
      invoke("focus_detected_process", {
        tmuxSession: q.tmux_session,
        windowName: q.window_name,
      }).catch(() => {});
    }
  }, [core.jobs, core.processes, questions]);

  const handleDisableAutoYes = useCallback((paneId: string) => {
    const next = new Set(autoYesPaneIds);
    next.delete(paneId);
    setAutoYesPaneIds(next);
    invoke("set_auto_yes_panes", { paneIds: [...next] }).catch(() => {});
  }, [autoYesPaneIds]);

  const autoYesEntries: AutoYesEntry[] = useMemo(() => {
    const entries: AutoYesEntry[] = [];
    for (const paneId of autoYesPaneIds) {
      const q = questions.find((q) => q.pane_id === paneId);
      if (q) {
        entries.push({ paneId, label: q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~"), jobSlug: q.matched_job });
        continue;
      }
      const proc = core.processes.find((p) => p.pane_id === paneId);
      if (proc) {
        entries.push({ paneId, label: proc.matched_job ?? proc.cwd.replace(/^\/Users\/[^/]+/, "~"), jobSlug: proc.matched_job });
        continue;
      }
      entries.push({ paneId, label: paneId });
    }
    return entries;
  }, [autoYesPaneIds, questions, core.processes]);

  // --- Settings & event listeners ---

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (s.group_order && s.group_order.length > 0) {
        setGroupOrder(s.group_order);
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
      // Don't clear pending placeholder processes - the swap effect handles those
      if (viewingProcess.pane_id.startsWith("_pending_")) return;
      const fresh = core.processes.find((p) => p.pane_id === viewingProcess.pane_id);
      if (!fresh) setViewingProcess(null);
      else if (fresh !== viewingProcess) setViewingProcess(fresh);
    }
  }, [core.processes, viewingProcess]);

  // Wait for agent process to appear after launching from group
  useEffect(() => {
    if (!pendingAgentWorkDir) return;
    const { dir, startedAt } = pendingAgentWorkDir;
    const match = core.processes.find((p) => p.cwd === dir && !p.pane_id.startsWith("_pending_"));
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
  }, [core.processes, pendingAgentWorkDir]);

  // Remove stopping placeholders once the real process disappears or times out
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
    // Try to find a job whose running status matches this pane
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
    // Try detected processes
    const proc = core.processes.find((p) => p.pane_id === pendingPaneId);
    if (proc) {
      setViewingProcess(proc);
      onPaneHandled?.();
      return;
    }
    // If not found yet and data is loaded, clear it
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
    if (importCwtKey && importCwtKey > 0) handleImportCwt();
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

  // Responsive: narrow window shows list-only view
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const isWide = windowWidth >= 768;

  // Prevent .tab-content parent from scrolling when split-pane is active
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
    // Determine target project path from the group's existing folder jobs
    const allJobs = await invoke<Job[]>("get_jobs");
    const targetJobs = allJobs.filter((j) => (j.group || "default") === targetGroup && j.folder_path);
    const targetProjectPath = targetJobs.length > 0
      ? targetJobs[0].folder_path
      : job.folder_path;

    if (!targetProjectPath) {
      // No folder path available - caller should use handleDuplicateToFolder instead
      return;
    }

    try {
      const newJob = await invoke<Job>("duplicate_job", {
        sourceSlug: job.slug,
        targetProjectPath,
      });
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
      const newJob = await invoke<Job>("duplicate_job", {
        sourceSlug: job.slug,
        targetProjectPath: folder,
      });
      await core.reload();
      setViewingJob(newJob);
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  }, [core.reload]);

  const handleOpen = useCallback(async (name: string) => {
    await invoke("focus_job_window", { name });
  }, []);

  // Build flat ordered list of all selectable items (jobs + processes) matching display order
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
      for (const [, gJobs] of grouped) {
        gJobs.sort((a, b) => a.name.localeCompare(b.name));
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
    // Build combined process list (replacing real with stopping variants, adding pending)
    const stoppingIds = new Set(stoppingProcesses.map((sp) => sp.process.pane_id));
    const allProcs = [
      ...core.processes.filter((p) => !stoppingIds.has(p.pane_id)),
      ...stoppingProcesses.map((sp) => sp.process),
      ...(pendingProcess ? [pendingProcess] : []),
    ];
    for (const key of keys) {
      for (const job of grouped.get(key) ?? []) {
        result.push({ kind: "job", slug: job.slug, job });
      }
      for (const proc of allProcs) {
        if (proc.matched_group === key) {
          result.push({ kind: "process", paneId: proc.pane_id, process: proc });
        }
      }
    }
    for (const proc of allProcs) {
      if (!proc.matched_group) {
        result.push({ kind: "process", paneId: proc.pane_id, process: proc });
      }
    }
    return result;
  }, [core.jobs, core.processes, sortMode, pendingProcess, stoppingProcesses]);

  const selectAdjacentItem = useCallback((currentId: string) => {
    const idx = orderedItems.findIndex((it) =>
      it.kind === "job" ? it.slug === currentId : it.paneId === currentId,
    );
    // Select previous item (up), or next if at top
    const prevIdx = idx > 0 ? idx - 1 : (orderedItems.length > 1 ? 1 : -1);
    if (prevIdx >= 0 && prevIdx < orderedItems.length) {
      const next = orderedItems[prevIdx];
      if (next.kind === "job") {
        setViewingProcess(null);
        setViewingAgent(false);
        setViewingJob(next.job);
        setScrollToSlug(next.slug);
      } else {
        setViewingJob(null);
        setViewingAgent(false);
        setViewingProcess(next.process);
        setScrollToSlug(next.paneId);
      }
    } else {
      setViewingJob(null);
      setViewingProcess(null);
    }
  }, [orderedItems]);


  const handleSelectJob = useCallback((job: RemoteJob) => {
    setViewingProcess(null);
    setViewingAgent(false);
    setViewingJob(job as Job);
  }, []);

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    setViewingJob(null);
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingProcess(null);
      setViewingAgent(true);
      return;
    }
    setViewingAgent(false);
    setViewingProcess(process);
  }, []);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string) => {
    if (workDir) {
      // Find the group this workDir belongs to so the placeholder appears in the right spot
      const matchingJob = (core.jobs as Job[]).find(
        (j) => j.folder_path === workDir || j.work_dir === workDir,
      );
      const matchedGroup = matchingJob ? (matchingJob.group || "default") : null;

      const placeholder: ClaudeProcess = {
        pane_id: `_pending_${Date.now()}`,
        cwd: workDir,
        version: "",
        tmux_session: "",
        window_name: "",
        matched_group: matchedGroup,
        matched_job: null,
        log_lines: "",
        first_query: prompt.slice(0, 80),
        last_query: null,
        session_started_at: new Date().toISOString(),
        _transient_state: "starting",
      };
      setPendingProcess(placeholder);
      setViewingJob(null);
      setViewingAgent(false);
      setViewingProcess(placeholder);
      setScrollToSlug(placeholder.pane_id);
      setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
    }
    await actions.runAgent(prompt, workDir);
  }, [actions, core.jobs]);

  const handleAddJob = useCallback((group: string, folderPath?: string) => {
    if (folderPath) {
      // Folder path provided directly (e.g. from detected group header)
      // Clean up detected group keys like "_det_/path/to/folder"
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

  // --- Question handlers ---

  const handleQuestionNavigate = useCallback((q: ClaudeQuestion, resolvedJob: string | null) => {
    if (resolvedJob) {
      const job = (core.jobs as Job[]).find((j) => j.slug === resolvedJob);
      if (job) { setViewingJob(job); return; }
    }
    const proc = core.processes.find((p) => p.pane_id === q.pane_id);
    if (proc) {
      setViewingProcess(proc);
    } else {
      invoke("focus_detected_process", {
        tmuxSession: q.tmux_session,
        windowName: q.window_name,
      }).catch(() => {});
    }
  }, [core.jobs, core.processes]);

  const handleQuestionSendOption = useCallback((q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
    if (resolvedJob) {
      invoke("send_job_input", { name: resolvedJob, text: optionNumber }).catch(() => {});
    } else {
      invoke("send_detected_process_input", { paneId: q.pane_id, text: optionNumber }).catch(() => {});
    }
    dismissedRef.current.set(q.question_id, Date.now());
    startFastQuestionPoll();
    setTimeout(() => {
      setQuestions((prev) => prev.filter((pq) => pq.question_id !== q.question_id));
    }, 750);
  }, [startFastQuestionPoll]);

  const resolveQuestionJob = useCallback(
    (q: ClaudeQuestion) => q.matched_job ?? null,
    [],
  );

  // --- Import job folder ---

  type ImportState =
    | null
    | { step: "pick-dest"; source: string; jobName: string }
    | { step: "confirm-duplicate"; source: string; destCwt: string; jobName: string };
  const [importState, setImportState] = useState<ImportState>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const doImport = useCallback(async (source: string, destCwt: string, jobName: string) => {
    try {
      await invoke("import_job_folder", { source, destCwt, jobName });
      await core.reload();
      setImportState(null);
      setImportError(null);
    } catch (e) {
      setImportError(typeof e === "string" ? e : String(e));
    }
  }, [core.reload]);

  const handleImportCwt = useCallback(async () => {
    setImportError(null);
    const selected = await open({ directory: true, title: "Select project folder (contains job.md)" });
    if (!selected) return;

    const source = selected as string;
    const parts = source.replace(/\/$/, "").split("/");
    const jobName = parts[parts.length - 1];

    // dest_cwt is now the project root directly
    const dest = source.replace(/\/$/, "");
    const existing = (core.jobs as Job[]).find(
      (j) => j.folder_path === dest && j.job_name === jobName,
    );
    if (existing) {
      setImportState({ step: "confirm-duplicate", source, destCwt: dest, jobName });
    } else {
      await doImport(source, dest, jobName);
    }
  }, [core.jobs, doImport]);

  const pickDestAndImport = useCallback(async (source: string, jobName: string) => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (!selected) return;
    const picked = (selected as string).replace(/\/+$/, "");
    const existing = (core.jobs as Job[]).find(
      (j) => j.folder_path === picked && j.job_name === jobName,
    );
    if (existing) {
      setImportState({ step: "confirm-duplicate", source, destCwt: picked, jobName });
    } else {
      await doImport(source, picked, jobName);
    }
  }, [core.jobs, doImport]);

  const handleImportPickDest = useCallback(async () => {
    if (!importState || importState.step !== "pick-dest") return;
    await pickDestAndImport(importState.source, importState.jobName);
  }, [importState, pickDestAndImport]);

  const handleImportDuplicate = useCallback(async () => {
    if (!importState || importState.step !== "confirm-duplicate") return;
    await pickDestAndImport(importState.source, importState.jobName);
  }, [importState, pickDestAndImport]);

  const handleRunMissedJobs = useCallback(async () => {
    const jobNames = missedCronJobs;
    setMissedCronJobs([]);
    for (const name of jobNames) {
      const job = (core.jobs as Job[]).find((j) => j.name === name);
      if (job) {
        await actions.runJob(job.slug);
      }
    }
  }, [missedCronJobs, core.jobs, actions]);

  // --- Drag-and-drop handlers ---

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true);
    setDragOverlayData(event.active.data.current as DragData);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    // Compute drop zone from pointer position relative to detail pane
    const el = detailPaneRef.current;
    if (!el) { setDragActiveZone(null); return; }
    const rect = el.getBoundingClientRect();
    const act = event.activatorEvent as PointerEvent;
    const dx = event.delta.x;
    const dy = event.delta.y;
    const px = act.clientX + dx;
    const py = act.clientY + dy;

    // Check if pointer is over the detail pane
    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      setDragActiveZone(null);
      return;
    }

    const zone = computeDropZone(
      px - rect.left, py - rect.top, rect.width, rect.height,
      splitItem !== null, splitDirection, splitRatio,
    );
    setDragActiveZone(zone);
  }, [splitItem, splitDirection, splitRatio]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setIsDragging(false);
    setDragOverlayData(null);
    const zone = dragActiveZone;
    setDragActiveZone(null);

    if (!zone) return;
    const data = event.active.data.current as DragData;
    if (!data) return;

    const item: SplitItem = data.kind === "job"
      ? { kind: "job", slug: data.slug }
      : { kind: "process", paneId: data.paneId };

    if (zone === "replace-current") {
      // Replace primary (select the item)
      if (data.kind === "job") {
        handleSelectJob(data.job);
      } else {
        handleSelectProcess(data.process);
      }
      return;
    }

    if (zone === "replace-primary") {
      if (data.kind === "job") {
        handleSelectJob(data.job);
      } else {
        handleSelectProcess(data.process);
      }
      return;
    }

    if (zone === "replace-secondary") {
      setSplitItem(item);
      return;
    }

    // Split zones
    const dir: SplitDirection =
      zone === "split-horizontal-left" || zone === "split-horizontal-right"
        ? "horizontal"
        : "vertical";

    setSplitDirection(dir);
    localStorage.setItem("split_direction", dir);
    setSplitRatio(0.5);
    localStorage.setItem("split_ratio", "0.5");

    if (zone === "split-horizontal-left" || zone === "split-vertical-top") {
      // New item goes to primary, current becomes secondary
      const currentPrimary: SplitItem | null = viewingAgent
        ? { kind: "agent" }
        : viewingProcess
          ? { kind: "process", paneId: viewingProcess.pane_id }
          : viewingJob
            ? { kind: "job", slug: viewingJob.slug }
            : null;
      setSplitItem(currentPrimary);
      if (data.kind === "job") handleSelectJob(data.job);
      else handleSelectProcess(data.process);
    } else {
      // New item goes to secondary
      setSplitItem(item);
    }
  }, [dragActiveZone, viewingAgent, viewingProcess, viewingJob, handleSelectJob, handleSelectProcess]);

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDragOverlayData(null);
    setDragActiveZone(null);
  }, []);

  const handleSplitRatioChange = useCallback((ratio: number) => {
    setSplitRatio(ratio);
    localStorage.setItem("split_ratio", String(ratio));
  }, []);

  const handleClosePrimary = useCallback(() => {
    // Promote secondary to primary
    if (splitItem) {
      if (splitItem.kind === "job") {
        const job = (core.jobs as Job[]).find((j) => j.slug === splitItem.slug);
        if (job) { setViewingJob(job); setViewingProcess(null); setViewingAgent(false); }
      } else if (splitItem.kind === "process") {
        const proc = core.processes.find((p) => p.pane_id === splitItem.paneId);
        if (proc) { setViewingProcess(proc); setViewingJob(null); setViewingAgent(false); }
      } else if (splitItem.kind === "agent") {
        setViewingAgent(true); setViewingJob(null); setViewingProcess(null);
      }
    }
    setSplitItem(null);
  }, [splitItem, core.jobs, core.processes]);

  const handleCloseSecondary = useCallback(() => {
    setSplitItem(null);
  }, []);

  // Render secondary pane content
  const renderSecondaryContent = useCallback(() => {
    if (!splitItem) return null;

    if (splitItem.kind === "agent") {
      const agentJob: RemoteJob = { name: "agent", job_type: "claude", enabled: true, cron: "", group: "", slug: "agent" };
      const agentStatus = core.statuses["agent"] ?? { state: "idle" as const };
      return (
        <AgentDetail
          transport={transport}
          job={agentJob}
          status={agentStatus}
          onBack={() => setSplitItem(null)}
          onOpen={() => handleOpen("agent")}
          showBackButton={false}
        />
      );
    }

    if (splitItem.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === splitItem.paneId);
      if (!proc) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span></div>;
      return (
        <DetectedProcessDetail
          process={proc}
          questions={questions}
          onBack={() => setSplitItem(null)}
          onDismissQuestion={(qId) => {
            dismissedRef.current.set(qId, Date.now());
            setQuestions((prev) => prev.filter((q) => q.question_id !== qId));
            startFastQuestionPoll();
          }}
          autoYesActive={autoYesPaneIds.has(proc.pane_id)}
          onToggleAutoYes={() => {
            const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
            if (paneQuestion) handleToggleAutoYes(paneQuestion);
            else handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
          }}
          showBackButton={false}
          onStopped={() => {
            setStoppingProcesses((prev) => [
              ...prev,
              { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() },
            ]);
            setSplitItem(null);
          }}
        />
      );
    }

    // job
    const job = (core.jobs as Job[]).find((j) => j.slug === splitItem.slug);
    if (!job) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span></div>;
    const jobQuestion = questions.find((q) => q.matched_job === job.slug);
    const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);
    return (
      <DesktopJobDetail
        transport={transport}
        job={job}
        status={core.statuses[job.slug] ?? { state: "idle" as const }}
        firstQuery={matchedProcess?.first_query ?? undefined}
        lastQuery={matchedProcess?.last_query ?? undefined}
        onBack={() => setSplitItem(null)}
        onEdit={() => { setEditingJob(job); setSplitItem(null); }}
        onOpen={() => handleOpen(job.slug)}
        onToggle={() => { actions.toggleJob(job.slug); core.reload(); }}
        onDuplicate={(group: string) => handleDuplicate(job, group)}
        onDuplicateToFolder={() => handleDuplicateToFolder(job)}
        onDelete={() => { setSplitItem(null); actions.deleteJob(job.slug); core.reload(); }}
        groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
        showBackButton={false}
        options={jobQuestion?.options}
        questionContext={jobQuestion?.context_lines}
        autoYesActive={(() => {
          const paneId = jobQuestion?.pane_id ?? (core.statuses[job.slug]?.state === "running" ? (core.statuses[job.slug] as { pane_id?: string }).pane_id : undefined);
          return paneId ? autoYesPaneIds.has(paneId) : false;
        })()}
        onToggleAutoYes={(() => {
          if (jobQuestion) return () => handleToggleAutoYes(jobQuestion);
          const status = core.statuses[job.slug];
          if (status?.state === "running") {
            const paneId = (status as { pane_id?: string }).pane_id;
            if (paneId) return () => handleToggleAutoYesByPaneId(paneId, job.name);
          }
          return undefined;
        })()}
      />
    );
  }, [splitItem, core.statuses, core.jobs, core.processes, questions, autoYesPaneIds, actions, handleToggleAutoYes, handleToggleAutoYesByPaneId, startFastQuestionPoll, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload]);

  // Custom card renderers for drag-and-drop
  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: boolean }) => (
      <DraggableJobCard {...props} />
    ),
    [],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: boolean }) => (
      <DraggableProcessCard {...props} />
    ),
    [],
  );

  // --- Notification visibility (animation delay) ---

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
    if (!nfnVisible && autoYesEntries.length === 0) return undefined;
    return (
      <>
        <AutoYesBanner entries={autoYesEntries} onDisable={handleDisableAutoYes} onPress={handleAutoYesPress} />
        {nfnVisible && (
          <NotificationSection
            questions={questions}
            resolveJob={resolveQuestionJob}
            onNavigate={handleQuestionNavigate}
            onSendOption={handleQuestionSendOption}
            collapsed={core.collapsedGroups.has("Notifications")}
            onToggleCollapse={() => core.toggleGroup("Notifications")}
            autoYesPaneIds={autoYesPaneIds}
            onToggleAutoYes={handleToggleAutoYes}
          />
        )}
      </>
    );
  }, [nfnVisible, questions, resolveQuestionJob, handleQuestionNavigate, handleQuestionSendOption, core.collapsedGroups, core.toggleGroup, autoYesPaneIds, handleToggleAutoYes, autoYesEntries, handleDisableAutoYes, handleAutoYesPress]);

  // --- Render ---

  if (editingJob || isCreating) {
    return (
      <>
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
            setEditingJob(null);
            setIsCreating(false);
            setCreateForGroup(null);
            setSaveError(null);
          }}
          onPickTemplate={(templateId) => {
            setIsCreating(false);
            setCreateForGroup(null);
            setPickerTemplateId(templateId);
            setShowPicker(true);
          }}
          defaultGroup={createForGroup?.group}
          defaultFolderPath={createForGroup?.folderPath ?? undefined}
        />
      </>
    );
  }

  if (showPicker) {
    return (
      <SamplePicker
        autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
        onCreated={() => {
          setShowPicker(false);
          setPickerTemplateId(null);
          onTemplateHandled?.();
          core.reload();
        }}
        onBlank={() => {
          setShowPicker(false);
          setPickerTemplateId(null);
          onTemplateHandled?.();
          setIsCreating(true);
        }}
        onCancel={() => {
          setShowPicker(false);
          setPickerTemplateId(null);
          onTemplateHandled?.();
        }}
      />
    );
  }

  // --- Detail pane content ---

  const detailPane = (() => {
    if (viewingAgent) {
      const agentJob: RemoteJob = {
        name: "agent",
        job_type: "claude",
        enabled: true,
        cron: "",
        group: "",
        slug: "agent",
      };
      const agentStatus = core.statuses["agent"] ?? { state: "idle" as const };
      return (
        <AgentDetail
          transport={transport}
          job={agentJob}
          status={agentStatus}
          onBack={() => setViewingAgent(false)}
          onOpen={() => handleOpen("agent")}
          showBackButton={!isWide}
        />
      );
    }

    if (viewingProcess && pendingProcess && viewingProcess.pane_id === pendingProcess.pane_id) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); setViewingProcess(null); }}>
              Back
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              Waiting for agent to start...
            </span>
          </div>
        </div>
      );
    }

    if (viewingProcess) {
      return (
        <>
          <DetectedProcessDetail
            process={viewingProcess}
            questions={questions}
            onBack={() => setViewingProcess(null)}
            onDismissQuestion={(qId) => {
              dismissedRef.current.set(qId, Date.now());
              setQuestions((prev) => prev.filter((q) => q.question_id !== qId));
              startFastQuestionPoll();
            }}
            autoYesActive={autoYesPaneIds.has(viewingProcess.pane_id)}
            onToggleAutoYes={() => {
              const paneQuestion = questions.find((q) => q.pane_id === viewingProcess.pane_id);
              if (paneQuestion) handleToggleAutoYes(paneQuestion);
              else handleToggleAutoYesByPaneId(viewingProcess.pane_id, viewingProcess.cwd.replace(/^\/Users\/[^/]+/, "~"));
            }}
            showBackButton={!isWide}
            onStopped={() => {
              setStoppingProcesses((prev) => [
                ...prev,
                { process: { ...viewingProcess, _transient_state: "stopping" }, stoppedAt: Date.now() },
              ]);
              selectAdjacentItem(viewingProcess.pane_id);
            }}
          />
          {pendingAutoYes && (
            <ConfirmDialog
              message={`Enable auto-yes for "${pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
              onConfirm={confirmAutoYes}
              onCancel={() => setPendingAutoYes(null)}
              confirmLabel="Enable"
              confirmClassName="btn btn-sm"
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
            transport={transport}
            job={viewingJob}
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
            showBackButton={!isWide}
            options={jobQuestion?.options}
            questionContext={jobQuestion?.context_lines}
            autoYesActive={(() => {
              const paneId = jobQuestion?.pane_id ?? (core.statuses[viewingJob.slug]?.state === "running" ? (core.statuses[viewingJob.slug] as { pane_id?: string }).pane_id : undefined);
              return paneId ? autoYesPaneIds.has(paneId) : false;
            })()}
            onToggleAutoYes={(() => {
              if (jobQuestion) return () => handleToggleAutoYes(jobQuestion);
              const status = core.statuses[viewingJob.slug];
              if (status?.state === "running") {
                const paneId = (status as { pane_id?: string }).pane_id;
                if (paneId) return () => handleToggleAutoYesByPaneId(paneId, viewingJob.name);
              }
              return undefined;
            })()}
          />
          {paramsDialog && (
            <ParamsOverlay
              job={paramsDialog.job}
              values={paramsDialog.values}
              onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
              onRun={handleRunWithParams}
              onCancel={() => setParamsDialog(null)}
            />
          )}
          {pendingAutoYes && (
            <ConfirmDialog
              message={`Enable auto-yes for "${pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
              onConfirm={confirmAutoYes}
              onCancel={() => setPendingAutoYes(null)}
              confirmLabel="Enable"
              confirmClassName="btn btn-sm"
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
          job={paramsDialog.job}
          values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams}
          onCancel={() => setParamsDialog(null)}
        />
      )}

      {pendingAutoYes && !viewingJob && !viewingProcess && (
        <ConfirmDialog
          message={`Enable auto-yes for "${pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={confirmAutoYes}
          onCancel={() => setPendingAutoYes(null)}
          confirmLabel="Enable"
          confirmClassName="btn btn-sm"
        />
      )}

      {importState?.step === "pick-dest" && (
        <ConfirmDialog
          message={`"${importState.jobName}" was not auto-detected. Select a project folder to import into.`}
          onConfirm={handleImportPickDest}
          onCancel={() => setImportState(null)}
          confirmLabel="Select folder"
          confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importState?.step === "confirm-duplicate" && (
        <ConfirmDialog
          message={`"${importState.jobName}" already exists in this project. Duplicate to a different project?`}
          onConfirm={handleImportDuplicate}
          onCancel={() => setImportState(null)}
          confirmLabel="Select folder"
          confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importError && (
        <ConfirmDialog
          message={importError}
          onConfirm={() => setImportError(null)}
          onCancel={() => setImportError(null)}
          confirmLabel="OK"
          confirmClassName="btn btn-sm"
        />
      )}

      {missedCronJobs.length > 0 && (
        <ConfirmDialog
          message={`${missedCronJobs.length} missed cron job${missedCronJobs.length > 1 ? "s" : ""} detected:\n\n${missedCronJobs.map((n) => "  - " + n).join("\n")}\n\nRun them now?`}
          onConfirm={handleRunMissedJobs}
          onCancel={() => setMissedCronJobs([])}
          confirmLabel="Run All"
          confirmClassName="btn btn-primary btn-sm"
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
      selectedSlug={viewingJob?.slug ?? viewingProcess?.pane_id ?? null}
      onRunAgent={handleRunAgent}
      onAddJob={handleAddJob}
      headerContent={notificationSection}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={scrollToSlug}
      scrollEnabled={!isDragging}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
    />
  );

  // Narrow window: list-only with full-screen detail navigation
  if (!isWide) {
    // Full-screen detail views for narrow mode
    if (viewingAgent || pendingAgentWorkDir || viewingProcess || viewingJob) {
      return <div style={{ margin: -20, height: "calc(100vh - 42px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>{detailPane}{dialogs}</div>;
    }
    return (
      <div className="settings-section">
        <div className="section-header">
          <h2>Jobs</h2>
        </div>
        {jobListView}
        {dialogs}
      </div>
    );
  }

  // Drag overlay content
  const dragOverlayContent = dragOverlayData ? (
    <div style={{ opacity: 0.8, pointerEvents: "none", width: 300 }}>
      {dragOverlayData.kind === "job" ? (
        (() => {
          const status = core.statuses[dragOverlayData.slug] ?? { state: "idle" as const };
          return status.state === "running"
            ? <RunningJobCard jobName={dragOverlayData.job.name} status={status} />
            : <JobCard job={dragOverlayData.job} status={status} />;
        })()
      ) : (
        <ProcessCard process={dragOverlayData.process} />
      )}
    </div>
  ) : null;

  // Drop zone overlay (shown during drag over detail pane)
  const dropOverlay = isDragging ? (
    <DropZoneOverlay
      isSplit={splitItem !== null}
      splitDirection={splitDirection}
      splitRatio={splitRatio}
      activeZone={dragActiveZone}
    />
  ) : null;

  // Wide window: split pane with DnD
  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div style={{ display: "flex", flexDirection: "row", height: "calc(100vh - 42px)", margin: -20, overflow: "hidden" }}>
        <div style={{ width: listWidth, minWidth: 260, maxWidth: 600, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", zIndex: 1 }}>
          {jobListView}
        </div>
        <div
          onMouseDown={onResizeHandleMouseDown}
          style={{ width: 9, backgroundColor: "transparent", marginLeft: -5, marginRight: -4, zIndex: 10, cursor: "col-resize", flexShrink: 0, position: "relative" }}
        />
        <div ref={detailPaneRef} className="detail-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)", position: "relative", zIndex: 2 }}>
          <SplitDetailArea
            primaryContent={detailPane}
            secondaryContent={splitItem ? renderSecondaryContent() : null}
            direction={splitDirection}
            ratio={splitRatio}
            onRatioChange={handleSplitRatioChange}
            onClosePrimary={splitItem ? handleClosePrimary : undefined}
            onCloseSecondary={splitItem ? handleCloseSecondary : undefined}
            overlay={dropOverlay}
          />
        </div>
        {dialogs}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragOverlayContent}
      </DragOverlay>
    </DndContext>
  );
}
