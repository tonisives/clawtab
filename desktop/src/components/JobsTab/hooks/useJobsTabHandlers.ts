import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import type { AutoYesEntry, ClaudeQuestion, DetectedProcess, useJobActions, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves, shortenPath } from "@clawtab/shared";
import type { Job } from "../../../types";
import type { DragData } from "../../DraggableCards";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useQuestionPolling } from "../../../hooks/useQuestionPolling";
import type { useViewingState } from "./useViewingState";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

interface UseJobsTabHandlersParams {
  actions: ReturnType<typeof useJobActions>;
  autoYes: ReturnType<typeof useAutoYes>;
  core: ReturnType<typeof useJobsCore>;
  handleJobReorder: (sourceSlug: string, targetSlug: string) => boolean;
  handleProcessReorder: (sourcePaneId: string, targetPaneId: string) => boolean;
  handleSplitPane: (paneId: string, direction: "right" | "down") => void;
  missedCronJobs: string[];
  onTemplateHandled?: () => void;
  questionPolling: ReturnType<typeof useQuestionPolling>;
  setMissedCronJobs: (names: string[]) => void;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
}

export function useJobsTabHandlers({
  actions,
  autoYes,
  core,
  handleJobReorder,
  handleProcessReorder,
  handleSplitPane,
  missedCronJobs,
  onTemplateHandled,
  questionPolling,
  setMissedCronJobs,
  split,
  viewing,
}: UseJobsTabHandlersParams) {
  const mgr = useWorkspaceManager();
  const {
    editingJob,
    paramsDialog,
    setCreateForGroup,
    setEditingJob,
    setIsCreating,
    setParamsDialog,
    setPickerTemplateId,
    setSaveError,
    setShowPicker,
    setViewingJob,
    setViewingProcess,
  } = viewing;

  const handleRunWithParams = useCallback(async () => {
    if (!paramsDialog) return;
    await actions.runJob(paramsDialog.job.slug, paramsDialog.values);
    setParamsDialog(null);
  }, [paramsDialog, actions, setParamsDialog]);

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
  }, [core, editingJob, setCreateForGroup, setEditingJob, setIsCreating, setSaveError, setViewingJob]);

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
  }, [core, setViewingJob]);

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
  }, [core, setViewingJob]);

  const handleOpen = useCallback(async (name: string) => {
    await invoke("focus_job_window", { name });
  }, []);

  const blurActiveListElement = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") active.blur();
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    split.handleDragStart(event);
  }, [split]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    split.handleDragMove(event);
  }, [split]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const data = event.active.data.current as DragData | null;
    const overId = typeof event.over?.id === "string" ? event.over.id : null;
    if (data?.kind === "job" && data.source === "sidebar" && overId) {
      handleJobReorder(data.slug, overId);
    }
    if (data?.kind === "process" && data.source === "sidebar" && overId) {
      handleProcessReorder(data.paneId, overId);
    }
    // Cross-workspace MOVE: pane dragged from another workspace into the
    // active one. Route through the manager so the source tree loses the
    // leaf atomically. Skip split.handleDragEnd (which would copy).
    const sourceWs = data?.source === "detail-pane" ? data.sourceWorkspaceId : undefined;
    if (sourceWs && sourceWs !== mgr.activeId && data) {
      let content: import("@clawtab/shared").PaneContent | null = null;
      if (data.kind === "job") content = { kind: "job", slug: data.slug };
      else if (data.kind === "process") content = { kind: "process", paneId: data.paneId };
      else if (data.kind === "terminal") content = { kind: "terminal", paneId: data.paneId, tmuxSession: data.tmuxSession };
      if (content) {
        mgr.movePaneTo(mgr.activeId, content);
        split.handleDragCancel();
        blurActiveListElement();
        return;
      }
    }
    split.handleDragEnd(event);
    blurActiveListElement();
  }, [blurActiveListElement, handleJobReorder, handleProcessReorder, mgr, split]);

  const handleDragCancel = useCallback(() => {
    split.handleDragCancel();
    blurActiveListElement();
  }, [blurActiveListElement, split]);

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
  }, [core.jobs, setCreateForGroup, setIsCreating]);

  const handleQuestionNavigate = useCallback((q: ClaudeQuestion, resolvedJob: string | null) => {
    questionPolling.handleQuestionNavigate(q, resolvedJob, core.jobs as Job[], core.processes, setViewingJob, setViewingProcess);
  }, [core.jobs, core.processes, questionPolling, setViewingJob, setViewingProcess]);

  const handleAutoYesPress = useCallback((entry: AutoYesEntry) => {
    const result = autoYes.handleAutoYesPress(entry);
    if (!result) return;
    if (result.kind === "job") {
      setViewingJob(result.job as Job);
      return;
    }
    if (result.kind === "process") setViewingProcess(result.process);
  }, [autoYes, setViewingJob, setViewingProcess]);

  const handleRunMissedJobs = useCallback(async () => {
    const jobNames = missedCronJobs;
    setMissedCronJobs([]);
    for (const name of jobNames) {
      const job = (core.jobs as Job[]).find((j) => j.name === name);
      if (job) await actions.runJob(job.slug);
    }
  }, [actions, core.jobs, missedCronJobs, setMissedCronJobs]);

  const resolveJobPaneId = useCallback((job: Job, jobQuestion?: ClaudeQuestion): string | undefined => {
    if (jobQuestion?.pane_id) return jobQuestion.pane_id;
    const status = core.statuses[job.slug];
    const statusPaneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
    if (statusPaneId) return statusPaneId;
    return core.processes.find((process) => process.matched_job === job.slug)?.pane_id;
  }, [core.processes, core.statuses]);

  const buildJobPaneActions = useCallback((job: Job, jobQuestion: ClaudeQuestion | undefined) => ({
    autoYesActive: (() => {
      const paneId = resolveJobPaneId(job, jobQuestion);
      return paneId ? autoYes.autoYesPaneIds.has(paneId) : false;
    })(),
    onToggleAutoYes: (() => {
      if (jobQuestion) return () => autoYes.handleToggleAutoYes(jobQuestion);
      const paneId = resolveJobPaneId(job);
      return paneId ? () => autoYes.handleToggleAutoYesByPaneId(paneId, job.name) : undefined;
    })(),
    onFork: undefined,
    onSplitPane: (() => {
      const paneId = resolveJobPaneId(job, jobQuestion);
      return paneId ? (direction: "right" | "down") => handleSplitPane(paneId, direction) : undefined;
    })(),
    onInjectSecrets: undefined,
    onSearchSkills: undefined,
    onZoomPane: () => {
      if (split.tree) {
        const leaves = collectLeaves(split.tree);
        const currentLeaf = leaves.find((leaf) => leaf.content.kind === "job" && leaf.content.slug === job.slug);
        if (currentLeaf) {
          split.toggleZoomLeaf(currentLeaf.id);
          return;
        }
      }
      split.toggleZoomLeaf("");
    },
  }), [autoYes, handleSplitPane, resolveJobPaneId, split]);

  const buildJobTitlePath = useCallback((job: Job, _jobQuestion: ClaudeQuestion | undefined) => {
    const sourcePath = job.work_dir || job.folder_path || job.path;
    return sourcePath ? shortenPath(sourcePath) : undefined;
  }, []);

  const buildProcessTitlePath = useCallback((process: DetectedProcess) => {
    return shortenPath(process.cwd);
  }, []);

  const handleCancelEditor = useCallback(() => {
    if (editingJob) setViewingJob(editingJob);
    setEditingJob(null);
    setIsCreating(false);
    setCreateForGroup(null);
    setSaveError(null);
  }, [editingJob, setCreateForGroup, setEditingJob, setIsCreating, setSaveError, setViewingJob]);

  const handlePickTemplate = useCallback((templateId: string) => {
    setIsCreating(false);
    setCreateForGroup(null);
    setPickerTemplateId(templateId);
    setShowPicker(true);
  }, [setCreateForGroup, setIsCreating, setPickerTemplateId, setShowPicker]);

  const handlePickerCreated = useCallback(() => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
    core.reload();
  }, [core, onTemplateHandled, setPickerTemplateId, setShowPicker]);

  const handlePickerBlank = useCallback(() => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
    setIsCreating(true);
  }, [onTemplateHandled, setIsCreating, setPickerTemplateId, setShowPicker]);

  const handlePickerCancel = useCallback(() => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
  }, [onTemplateHandled, setPickerTemplateId, setShowPicker]);

  return {
    buildJobPaneActions,
    buildJobTitlePath,
    buildProcessTitlePath,
    handleAddJob,
    handleAutoYesPress,
    handleCancelEditor,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    handleDuplicate,
    handleDuplicateToFolder,
    handleOpen,
    handlePickTemplate,
    handlePickerBlank,
    handlePickerCancel,
    handlePickerCreated,
    handleQuestionNavigate,
    handleRunMissedJobs,
    handleRunWithParams,
    handleSave,
  };
}
