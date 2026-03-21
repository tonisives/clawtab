import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { RemoteJob, JobSortMode } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import {
  JobListView,
  NotificationSection,
  AutoYesBanner,
  useJobsCore,
  useJobActions,
} from "@clawtab/shared";
import type { AutoYesEntry } from "@clawtab/shared";
import { createTauriTransport } from "../transport/tauriTransport";
import type { AppSettings, Job } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetectedProcessDetail } from "./DetectedProcessDetail";
import { DesktopJobDetail, AgentDetail } from "./JobDetailSections";
import { ParamsOverlay } from "./ParamsOverlay";

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
      const fresh = core.processes.find((p) => p.pane_id === viewingProcess.pane_id);
      if (fresh && fresh !== viewingProcess) setViewingProcess(fresh);
    }
  }, [core.processes, viewingProcess]);

  // Wait for agent process to appear after launching from group
  useEffect(() => {
    if (!pendingAgentWorkDir) return;
    const { dir, startedAt } = pendingAgentWorkDir;
    const match = core.processes.find((p) => p.cwd === dir);
    if (match) {
      setPendingAgentWorkDir(null);
      setViewingProcess(match);
      return;
    }
    if (Date.now() - startedAt > 15000) {
      setPendingAgentWorkDir(null);
    }
  }, [core.processes, pendingAgentWorkDir]);

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

  // Scroll to top when entering sub-views
  useEffect(() => {
    if (editingJob || isCreating || showPicker || viewingJob || viewingProcess) {
      const tabContent = document.querySelector(".tab-content");
      if (tabContent) tabContent.scrollTop = 0;
    }
  }, [editingJob, isCreating, showPicker, viewingJob, viewingProcess]);

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

  const handleSelectJob = useCallback((job: RemoteJob) => {
    setViewingJob(job as Job);
  }, []);

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingAgent(true);
      return;
    }
    setViewingProcess(process);
  }, []);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string) => {
    await actions.runAgent(prompt, workDir);
    if (workDir) {
      // Strip /.cwt suffix to match the actual CWD the agent will run in
      const dir = workDir.endsWith("/.cwt") ? workDir.slice(0, -5) : workDir;
      setPendingAgentWorkDir({ dir, startedAt: Date.now() });
    }
  }, [actions]);

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

  // --- Import .cwt ---

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
    const selected = await open({ directory: true, title: "Select job folder (contains job.md)" });
    if (!selected) return;

    const source = selected as string;
    const parts = source.replace(/\/$/, "").split("/");
    const jobName = parts[parts.length - 1];
    const parentName = parts.length >= 2 ? parts[parts.length - 2] : "";

    if (parentName === ".cwt") {
      const destCwt = parts.slice(0, -1).join("/");
      const existing = (core.jobs as Job[]).find(
        (j) => j.folder_path === destCwt && j.job_name === jobName,
      );
      if (existing) {
        setImportState({ step: "confirm-duplicate", source, destCwt, jobName });
      } else {
        await doImport(source, destCwt, jobName);
      }
    } else {
      setImportState({ step: "pick-dest", source, jobName });
    }
  }, [core.jobs, doImport]);

  const pickDestAndImport = useCallback(async (source: string, jobName: string) => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (!selected) return;
    const picked = (selected as string).replace(/\/+$/, "");
    const destCwt = picked.endsWith("/.cwt") || picked.endsWith(".cwt")
      ? picked
      : picked + "/.cwt";
    const existing = (core.jobs as Job[]).find(
      (j) => j.folder_path === destCwt && j.job_name === jobName,
    );
    if (existing) {
      setImportState({ step: "confirm-duplicate", source, destCwt, jobName });
    } else {
      await doImport(source, destCwt, jobName);
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
      />
    );
  }

  if (pendingAgentWorkDir) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn btn-sm" onClick={() => setPendingAgentWorkDir(null)}>
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
    return (
      <>
        <DesktopJobDetail
          transport={transport}
          job={viewingJob}
          status={core.statuses[viewingJob.slug] ?? { state: "idle" as const }}
          onBack={() => setViewingJob(null)}
          onEdit={() => { setEditingJob(viewingJob); setViewingJob(null); }}
          onOpen={() => handleOpen(viewingJob.slug)}
          onToggle={() => { actions.toggleJob(viewingJob.slug); core.reload(); }}
          onDuplicate={(group: string) => handleDuplicate(viewingJob, group)}
          onDuplicateToFolder={() => handleDuplicateToFolder(viewingJob)}
          onDelete={() => { actions.deleteJob(viewingJob.slug); setViewingJob(null); core.reload(); }}
          groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
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
    <div className="settings-section">
      <div className="section-header">
        <h2>Jobs</h2>
      </div>

      <JobListView
        jobs={core.jobs}
        statuses={core.statuses}
        detectedProcesses={core.processes}
        collapsedGroups={core.collapsedGroups}
        onToggleGroup={core.toggleGroup}
        groupOrder={groupOrder}
        sortMode={sortMode}
        onSortChange={setSortMode}
        onSelectJob={handleSelectJob}
        onSelectProcess={handleSelectProcess}
        onRunAgent={handleRunAgent}
        onAddJob={handleAddJob}
        headerContent={notificationSection}
        showEmpty={core.loaded}
        emptyMessage="No jobs configured yet."
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

      {importState?.step === "pick-dest" && (
        <ConfirmDialog
          message={`"${importState.jobName}" is not inside a .cwt folder. Select a project folder to import into.`}
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
    </div>
  );
}
