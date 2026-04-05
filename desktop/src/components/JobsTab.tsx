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
  LegacySplitDetailArea as SplitDetailArea,
  LegacyDropZoneOverlay as DropZoneOverlay,
  JobCard,
  RunningJobCard,
  ProcessCard,
  useJobsCore,
  useJobActions,
} from "@clawtab/shared";
import type { AutoYesEntry, SplitDirection } from "@clawtab/shared";
import { createTauriTransport } from "../transport/tauriTransport";
import type { AppSettings, Job } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetectedProcessDetail } from "./DetectedProcessDetail";
import { DesktopJobDetail, AgentDetail } from "./JobDetailSections";
import { ParamsOverlay } from "./ParamsOverlay";
import { DraggableJobCard, DraggableProcessCard } from "./DraggableCards";
import { SkillSearchDialog } from "./SkillSearchDialog";
import { InjectSecretsDialog } from "./InjectSecretsDialog";
import { useQuestionPolling } from "../hooks/useQuestionPolling";
import { useAutoYes } from "../hooks/useAutoYes";
import { useDragDrop } from "../hooks/useDragDrop";
import { useImportJob } from "../hooks/useImportJob";

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

  const dragDrop = useDragDrop(
    splitItem, splitDirection, splitRatio,
    (dir) => { setSplitDirection(dir); localStorage.setItem("split_direction", dir); },
    (ratio) => { setSplitRatio(ratio); localStorage.setItem("split_ratio", String(ratio)); },
    setSplitItem,
    viewingAgent, viewingProcess, viewingJob,
    handleSelectJob, handleSelectProcess,
  );

  const importJob = useImportJob(core.jobs as Job[], core.reload);

  // --- Fork handlers ---

  const handleFork = useCallback(async (paneId: string) => {
    try {
      const newPaneId = await invoke<string>("fork_pane", { paneId });
      await core.reload();
      setSplitItem({ kind: "process", paneId: newPaneId });
    } catch (e) {
      console.error("fork_pane failed:", e);
    }
  }, [core.reload]);

  const handleForkWithSecrets = useCallback(async (paneId: string, secretKeys: string[]) => {
    try {
      const newPaneId = await invoke<string>("fork_pane_with_secrets", { paneId, secretKeys });
      await core.reload();
      setSplitItem({ kind: "process", paneId: newPaneId });
    } catch (e) {
      console.error("fork_pane_with_secrets failed:", e);
    }
  }, [core.reload]);

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
      const placeholder: ClaudeProcess = {
        pane_id: `_pending_${Date.now()}`, cwd: workDir, version: "", tmux_session: "", window_name: "",
        matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
        last_query: null, session_started_at: new Date().toISOString(), _transient_state: "starting",
      };
      setPendingProcess(placeholder);
      setViewingJob(null); setViewingAgent(false); setViewingProcess(placeholder);
      setScrollToSlug(placeholder.pane_id);
      setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
    }
    await actions.runAgent(prompt, workDir);
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

  const handleSplitRatioChange = useCallback((ratio: number) => {
    setSplitRatio(ratio);
    localStorage.setItem("split_ratio", String(ratio));
  }, []);

  const handleClosePrimary = useCallback(() => {
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

  const handleCloseSecondary = useCallback(() => { setSplitItem(null); }, []);

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
      return paneId ? () => handleFork(paneId) : undefined;
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
  }), [core.statuses, autoYes, handleFork]);

  // Render secondary pane content
  const renderSecondaryContent = useCallback(() => {
    if (!splitItem) return null;

    if (splitItem.kind === "agent") {
      const agentJob: RemoteJob = { name: "agent", job_type: "claude", enabled: true, cron: "", group: "", slug: "agent" };
      return (
        <AgentDetail transport={transport} job={agentJob} status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => setSplitItem(null)} onOpen={() => handleOpen("agent")} showBackButton={false} />
      );
    }

    if (splitItem.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === splitItem.paneId);
      if (!proc) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span></div>;
      return (
        <DetectedProcessDetail
          process={proc} questions={questions}
          onBack={() => setSplitItem(null)}
          onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
          autoYesActive={autoYes.autoYesPaneIds.has(proc.pane_id)}
          onToggleAutoYes={() => {
            const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
            if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
            else autoYes.handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
          }}
          showBackButton={false}
          onStopped={() => {
            setStoppingProcesses((prev) => [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }]);
            setSplitItem(null);
          }}
          onFork={() => handleFork(proc.pane_id)}
          onInjectSecrets={() => setInjectSecretsPaneId(proc.pane_id)}
          onSearchSkills={() => setSkillSearchPaneId(proc.pane_id)}
        />
      );
    }

    const job = (core.jobs as Job[]).find((j) => j.slug === splitItem.slug);
    if (!job) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span></div>;
    const jobQuestion = questions.find((q) => q.matched_job === job.slug);
    const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);
    return (
      <DesktopJobDetail
        transport={transport} job={job}
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
        {...buildJobPaneActions(job, jobQuestion)}
      />
    );
  }, [splitItem, core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, questionPolling, buildJobPaneActions]);

  // Custom card renderers for drag-and-drop
  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: string | boolean }) => <DraggableJobCard {...props} />,
    [],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: string | boolean }) => <DraggableProcessCard {...props} />,
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
          onBack={() => setViewingAgent(false)} onOpen={() => handleOpen("agent")} showBackButton={!isWide} />
      );
    }

    if (viewingProcess && pendingProcess && viewingProcess.pane_id === pendingProcess.pane_id) {
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
            showBackButton={!isWide}
            onStopped={() => {
              setStoppingProcesses((prev) => [...prev, { process: { ...viewingProcess, _transient_state: "stopping" }, stoppedAt: Date.now() }]);
              selectAdjacentItem(viewingProcess.pane_id);
            }}
            onFork={() => handleFork(viewingProcess.pane_id)}
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
            showBackButton={!isWide}
            options={jobQuestion?.options}
            questionContext={jobQuestion?.context_lines}
            {...buildJobPaneActions(viewingJob, jobQuestion)}
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
      selectedSlug={viewingJob?.slug ?? viewingProcess?.pane_id ?? null}
      onRunAgent={handleRunAgent}
      onAddJob={handleAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={handleHideGroup}
      onUnhideGroup={handleUnhideGroup}
      headerContent={notificationSection}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={scrollToSlug}
      scrollEnabled={!dragDrop.isDragging}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
    />
  );

  const dragOverlayContent = dragDrop.dragOverlayData ? (
    <div style={{ opacity: 0.8, pointerEvents: "none", width: 300 }}>
      {dragDrop.dragOverlayData.kind === "job" ? (
        (() => {
          const status = core.statuses[dragDrop.dragOverlayData.slug] ?? { state: "idle" as const };
          return status.state === "running"
            ? <RunningJobCard jobName={dragDrop.dragOverlayData.job.name} status={status} />
            : <JobCard job={dragDrop.dragOverlayData.job} status={status} />;
        })()
      ) : (
        <ProcessCard process={dragDrop.dragOverlayData.process} />
      )}
    </div>
  ) : null;

  const dropOverlay = dragDrop.isDragging ? (
    <DropZoneOverlay
      isSplit={splitItem !== null}
      splitDirection={splitDirection}
      splitRatio={splitRatio}
      activeZone={dragDrop.dragActiveZone}
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
            <div style={{ margin: -20, height: "calc(100vh - 42px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>{detailPane}{dialogs}</div>
          ) : (
            <div className="settings-section">
              <div className="section-header"><h2>Jobs</h2></div>
              {jobListView}
              {dialogs}
            </div>
          )
        ) : (
          <DndContext
            sensors={dragDrop.sensors}
            onDragStart={dragDrop.handleDragStart}
            onDragMove={dragDrop.handleDragMove}
            onDragEnd={dragDrop.handleDragEnd}
            onDragCancel={dragDrop.handleDragCancel}
          >
            <div style={{ display: "flex", flexDirection: "row", height: "calc(100vh - 42px)", margin: -20, overflow: "hidden" }}>
              <div style={{ width: listWidth, minWidth: 260, maxWidth: 600, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {jobListView}
              </div>
              <div onMouseDown={onResizeHandleMouseDown} style={{ width: 9, backgroundColor: "transparent", marginLeft: -5, marginRight: -4, zIndex: 10, cursor: "col-resize", flexShrink: 0, position: "relative" }} />
              <div ref={dragDrop.detailPaneRef} className="detail-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)" }}>
                <SplitDetailArea
                  primaryContent={detailPane}
                  secondaryContent={splitItem ? renderSecondaryContent() : null}
                  direction={splitDirection} ratio={splitRatio}
                  onRatioChange={handleSplitRatioChange}
                  onClosePrimary={splitItem ? handleClosePrimary : undefined}
                  onCloseSecondary={splitItem ? handleCloseSecondary : undefined}
                  overlay={dropOverlay}
                />
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
