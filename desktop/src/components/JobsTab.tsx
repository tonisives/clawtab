import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import {
  JobListView,
  JobDetailView,
  NotificationSection,
  useJobsCore,
  useJobActions,
  useJobDetail,
  useLogBuffer,
} from "@clawtab/shared";
import { createTauriTransport } from "../transport/tauriTransport";
import type { AppSettings, Job } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeCron } from "./CronInput";

const transport = createTauriTransport();

const EDITOR_LABELS: Record<string, string> = {
  nvim: "Neovim",
  vim: "Vim",
  code: "VS Code",
  codium: "VSCodium",
  zed: "Zed",
  hx: "Helix",
  subl: "Sublime Text",
  emacs: "Emacs",
};

interface JobsTabProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
}

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey }: JobsTabProps) {
  const core = useJobsCore(transport);
  const actions = useJobActions(transport, core.reloadStatuses);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);

  // Desktop-only state
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTemplateId, setPickerTemplateId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewingJob, setViewingJob] = useState<Job | null>(null);
  const [createForGroup, setCreateForGroup] = useState<{ group: string; folderPath: string | null } | null>(null);
  const [viewingAgent, setViewingAgent] = useState(false);
  const [paramsDialog, setParamsDialog] = useState<{ job: Job; values: Record<string, string> } | null>(null);
  const [questions, setQuestions] = useState<ClaudeQuestion[]>([]);
  const questionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track recently dismissed question IDs so polls don't bring them back
  const dismissedRef = useRef<Map<string, number>>(new Map());

  const loadQuestions = useCallback(() => {
    invoke<ClaudeQuestion[]>("get_active_questions").then((qs) => {
      console.log("[nfn] loadQuestions got", qs.length, "questions");
      const now = Date.now();
      // Purge stale dismissals (>10s)
      for (const [id, ts] of dismissedRef.current) {
        if (now - ts > 10000) dismissedRef.current.delete(id);
      }
      setQuestions(qs.filter((q) => !dismissedRef.current.has(q.question_id)));
    }).catch((e) => { console.error("[nfn] loadQuestions error", e); });
  }, []);

  // Poll for active questions
  useEffect(() => {
    console.log("[nfn] mounting, calling loadQuestions immediately");
    loadQuestions();
    questionPollRef.current = setInterval(loadQuestions, 5000);
    return () => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    };
  }, [loadQuestions]);

  // Temporarily switch to fast polling (500ms for 5s) after answering a question
  const startFastQuestionPoll = useCallback(() => {
    if (questionPollRef.current) clearInterval(questionPollRef.current);
    if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    questionPollRef.current = setInterval(loadQuestions, 500);
    fastPollTimerRef.current = setTimeout(() => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      questionPollRef.current = setInterval(loadQuestions, 5000);
    }, 5000);
  }, [loadQuestions]);

  // Load group order from settings
  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (s.group_order && s.group_order.length > 0) {
        setGroupOrder(s.group_order);
      }
    }).catch(() => {});
  }, []);

  // Listen for jobs-changed events to reload (supplements the shared hook's polling)
  useEffect(() => {
    const unlistenPromise = listen("jobs-changed", () => {
      core.reload();
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [core.reload]);

  // Update viewingJob when jobs reload
  useEffect(() => {
    if (viewingJob) {
      const fresh = (core.jobs as Job[]).find((j) => j.name === viewingJob.name);
      if (fresh && fresh !== viewingJob) {
        setViewingJob(fresh);
      }
    }
  }, [core.jobs, viewingJob]);

  useEffect(() => {
    if (pendingTemplateId) {
      setShowPicker(true);
    }
  }, [pendingTemplateId]);

  useEffect(() => {
    if (createJobKey && createJobKey > 0) {
      setIsCreating(true);
    }
  }, [createJobKey]);

  // Scroll tab-content to top when switching to editor/picker/detail views
  useEffect(() => {
    if (editingJob || isCreating || showPicker || viewingJob) {
      const tabContent = document.querySelector(".tab-content");
      if (tabContent) tabContent.scrollTop = 0;
    }
  }, [editingJob, isCreating, showPicker, viewingJob]);

  const handleRunWithParams = useCallback(async () => {
    if (!paramsDialog) return;
    await actions.runJob(paramsDialog.job.name, paramsDialog.values);
    setParamsDialog(null);
  }, [paramsDialog, actions]);

  const handleSave = useCallback(async (job: Job) => {
    setSaveError(null);
    try {
      const wasEditing = editingJob;
      const renamed = editingJob && job.name !== editingJob.name;
      if (renamed) {
        await invoke("delete_job", { name: editingJob.name });
        job = { ...job, slug: "" };
      }
      await invoke("save_job", { job });
      await core.reload();
      setEditingJob(null);
      setIsCreating(false);
      if (wasEditing) {
        setViewingJob(job);
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setSaveError(msg);
      console.error("Failed to save job:", e);
    }
  }, [editingJob, core.reload]);

  const handleDuplicate = useCallback(async (job: Job) => {
    const existingNames = new Set(core.jobs.map((j) => j.name));
    let copyName = `${job.name}-copy`;
    let i = 2;
    while (existingNames.has(copyName)) {
      copyName = `${job.name}-copy-${i}`;
      i++;
    }
    const dup: Job = { ...job, name: copyName, slug: "", enabled: false };
    await invoke("save_job", { job: dup });
    await core.reload();
  }, [core.jobs, core.reload]);

  const handleOpen = useCallback(async (name: string) => {
    await invoke("focus_job_window", { name });
  }, []);

  const handleSelectJob = useCallback((job: RemoteJob) => {
    setViewingJob(job as Job);
  }, []);

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    // If this is the agent process, show agent detail view
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingAgent(true);
      return;
    }
    // Otherwise, open the terminal window
    invoke("focus_detected_process", {
      tmuxSession: process.tmux_session,
      windowName: process.window_name,
    }).catch(() => {});
  }, []);

  const handleRunAgent = useCallback(async (prompt: string) => {
    await actions.runAgent(prompt);
  }, [actions]);

  const handleAddJob = useCallback((group: string) => {
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
    if (resolvedJob) {
      const job = (core.jobs as Job[]).find((j) => j.name === resolvedJob);
      if (job) { setViewingJob(job); return; }
    }
    invoke("focus_detected_process", {
      tmuxSession: q.tmux_session,
      windowName: q.window_name,
    }).catch(() => {});
  }, [core.jobs]);

  const handleQuestionSendOption = useCallback((q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
    if (resolvedJob) {
      invoke("send_job_input", { name: resolvedJob, text: optionNumber }).catch(() => {});
    } else {
      invoke("send_detected_process_input", { paneId: q.pane_id, text: optionNumber }).catch(() => {});
    }
    // Optimistically remove and suppress re-polling from bringing it back
    dismissedRef.current.set(q.question_id, Date.now());
    setQuestions((prev) => prev.filter((pq) => pq.question_id !== q.question_id));
    startFastQuestionPoll();
  }, [startFastQuestionPoll]);

  const resolveQuestionJob = useCallback(
    (q: ClaudeQuestion) => q.matched_job ?? null,
    [],
  );

  // Keep rendering NotificationSection briefly after questions drop to 0 so departure
  // animations play out before the section disappears.
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
    if (!nfnVisible) return undefined;
    return (
      <NotificationSection
        questions={questions}
        resolveJob={resolveQuestionJob}
        onNavigate={handleQuestionNavigate}
        onSendOption={handleQuestionSendOption}
        collapsed={core.collapsedGroups.has("Notifications")}
        onToggleCollapse={() => core.toggleGroup("Notifications")}
      />
    );
  }, [nfnVisible, questions, resolveQuestionJob, handleQuestionNavigate, handleQuestionSendOption, core.collapsedGroups, core.toggleGroup]);

  // Editor / picker screens (React DOM, kept as-is)
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
        job={agentJob}
        status={agentStatus}
        onBack={() => setViewingAgent(false)}
        onOpen={() => handleOpen("agent")}
      />
    );
  }

  if (viewingJob) {
    return (
      <>
        <DesktopJobDetail
          job={viewingJob}
          status={core.statuses[viewingJob.name] ?? { state: "idle" as const }}
          onBack={() => setViewingJob(null)}
          onEdit={() => { setEditingJob(viewingJob); setViewingJob(null); }}
          onOpen={() => handleOpen(viewingJob.name)}
          onToggle={() => { actions.toggleJob(viewingJob.name); core.reload(); }}
          onDuplicate={() => handleDuplicate(viewingJob)}
          onDelete={() => { actions.deleteJob(viewingJob.name); setViewingJob(null); core.reload(); }}
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
      </>
    );
  }

  // Main jobs list using shared component
  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Jobs</h2>
        <div className="btn-group">
          <button className="btn btn-primary btn-sm" onClick={() => setIsCreating(true)}>
            Add Job
          </button>
        </div>
      </div>

      <JobListView
        jobs={core.jobs}
        statuses={core.statuses}
        detectedProcesses={core.processes}
        collapsedGroups={core.collapsedGroups}
        onToggleGroup={core.toggleGroup}
        groupOrder={groupOrder}
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
    </div>
  );
}

// Desktop job detail - wraps the shared JobDetailView with desktop-specific sections
function DesktopJobDetail({
  job,
  status,
  onBack,
  onEdit,
  onOpen,
  onToggle,
  onDuplicate,
  onDelete,
}: {
  job: Job;
  status: JobStatus;
  onBack: () => void;
  onEdit: () => void;
  onOpen: () => void;
  onToggle: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { runs, reloadRuns } = useJobDetail(transport, job.name);
  const { logs } = useLogBuffer(transport, job.name);
  const [showConfirm, setShowConfirm] = useState(false);

  const extraContent = useMemo(
    () => <DesktopDetailSections job={job} />,
    [job],
  );

  return (
    <>
      <JobDetailView
        transport={transport}
        job={job as unknown as RemoteJob}
        status={status}
        logs={logs}
        runs={runs}
        onBack={onBack}
        onReloadRuns={reloadRuns}
        onEdit={onEdit}
        onOpen={onOpen}
        onToggleEnabled={onToggle}
        onDuplicate={onDuplicate}
        onDelete={() => setShowConfirm(true)}
        extraContent={extraContent}
      />
      {showConfirm && (
        <ConfirmDialog
          message={`Delete job "${job.name}"? This cannot be undone.`}
          onConfirm={() => { onDelete(); setShowConfirm(false); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}

// Agent detail view - wraps shared JobDetailView for the agent
function AgentDetail({
  job,
  status,
  onBack,
  onOpen,
}: {
  job: RemoteJob;
  status: JobStatus;
  onBack: () => void;
  onOpen: () => void;
}) {
  const { runs, reloadRuns } = useJobDetail(transport, "agent");
  const { logs } = useLogBuffer(transport, "agent");

  const extraContent = useMemo(
    () => <AgentDetailSections />,
    [],
  );

  return (
    <JobDetailView
      transport={transport}
      job={job}
      status={status}
      logs={logs}
      runs={runs}
      onBack={onBack}
      onReloadRuns={reloadRuns}
      onOpen={onOpen}
      extraContent={extraContent}
    />
  );
}

// Agent directions - shows cwt.md context with option to open in editor
function AgentDetailSections() {
  const [directionsCollapsed, setDirectionsCollapsed] = useState(false);
  const [cwtContext, setCwtContext] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    }).catch(() => {});
  }, []);

  const reloadContext = useCallback(() => {
    invoke<string>("read_agent_context")
      .then(setCwtContext)
      .catch(() => setCwtContext(null));
  }, []);

  useEffect(() => {
    reloadContext();
  }, [reloadContext]);

  useEffect(() => {
    const interval = setInterval(reloadContext, 2000);
    return () => clearInterval(interval);
  }, [reloadContext]);

  useEffect(() => {
    const onFocus = () => reloadContext();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadContext]);

  return (
    <div className="field-group">
      <button
        onClick={() => setDirectionsCollapsed((v) => !v)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
        }}
        className="field-group-title"
      >
        <span style={{ fontFamily: "monospace", fontSize: 9 }}>
          {directionsCollapsed ? "\u25B6" : "\u25BC"}
        </span>
        Directions
      </button>
      {!directionsCollapsed && (
        <div style={{ marginTop: 8 }}>
          <pre style={{
            padding: "10px 12px",
            height: 350,
            minHeight: 225,
            overflowY: "auto",
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-primary)",
            background: "var(--bg-secondary)",
            whiteSpace: "pre-wrap",
            margin: 0,
            border: "1px solid var(--border-color)",
            borderRadius: 7,
            boxSizing: "border-box",
          }}>
            {cwtContext || "(no cwt.md)"}
          </pre>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                invoke("open_agent_editor", { fileName: "cwt.md" });
              }}
            >
              Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Desktop-only detail sections: Directions, Configuration, Runtime, Secrets
function DesktopDetailSections({ job }: { job: Job }) {
  const [directionsCollapsed, setDirectionsCollapsed] = useState(false);
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [previewFile, setPreviewFile] = useState<"job.md" | "cwt.md">("job.md");
  const [inlineContent, setInlineContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [cwtContextPreview, setCwtContextPreview] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;

  const dirty = inlineContent !== savedContent;

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    }).catch(() => {});
  }, []);

  const reloadDirections = useCallback(() => {
    if (job.job_type !== "folder" || !job.folder_path) return;
    const jn = job.job_name ?? "default";
    invoke<string>("read_cwt_entry", { folderPath: job.folder_path, jobName: jn })
      .then((content) => {
        setInlineContent((prev) => prev === savedContentRef.current ? content : prev);
        setSavedContent(content);
      })
      .catch(() => {});
  }, [job]);

  useEffect(() => {
    if (job.job_type === "folder" && job.folder_path) {
      const jn = job.job_name ?? "default";
      invoke<string>("read_cwt_entry", { folderPath: job.folder_path, jobName: jn })
        .then((content) => {
          setInlineContent(content);
          setSavedContent(content);
        })
        .catch(() => {});
      invoke<string>("read_cwt_context", { folderPath: job.folder_path, jobName: jn })
        .then(setCwtContextPreview)
        .catch(() => setCwtContextPreview(null));
    }
  }, [job]);

  useEffect(() => {
    if (job.job_type !== "folder" || !job.folder_path) return;
    const interval = setInterval(reloadDirections, 2000);
    return () => clearInterval(interval);
  }, [job, reloadDirections]);

  useEffect(() => {
    const onFocus = () => reloadDirections();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadDirections]);

  const handleSaveDirections = () => {
    if (job.folder_path) {
      invoke("write_cwt_entry", {
        folderPath: job.folder_path,
        jobName: job.job_name ?? "default",
        content: inlineContent,
      }).then(() => {
        setSavedContent(inlineContent);
      }).catch(() => {});
    }
  };

  return (
    <>
      {/* Directions (folder jobs only) */}
      {job.job_type === "folder" && job.folder_path && (
        <div className="field-group">
          <button
            onClick={() => setDirectionsCollapsed((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: 0,
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
            }}
            className="field-group-title"
          >
            <span style={{ fontFamily: "monospace", fontSize: 9 }}>
              {directionsCollapsed ? "\u25B6" : "\u25BC"}
            </span>
            Directions
          </button>
          {!directionsCollapsed && (
            <div style={{ marginTop: 8 }}>
              <div className="directions-box">
                <div className="directions-tabs">
                  <button
                    className={`directions-tab ${previewFile === "job.md" ? "active" : ""}`}
                    onClick={() => setPreviewFile("job.md")}
                  >
                    job.md
                  </button>
                  <button
                    className={`directions-tab ${previewFile === "cwt.md" ? "active" : ""}`}
                    onClick={() => setPreviewFile("cwt.md")}
                  >
                    cwt.md
                  </button>
                </div>
                {previewFile === "job.md" ? (
                  <textarea
                    className="directions-editor"
                    value={inlineContent}
                    onChange={(e) => setInlineContent(e.target.value)}
                    spellCheck={false}
                    placeholder=""
                  />
                ) : (
                  <pre className="directions-body">
                    {cwtContextPreview || "(no cwt.md)"}
                  </pre>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                {dirty && (
                  <button className="btn btn-primary btn-sm" onClick={handleSaveDirections}>
                    Save
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    invoke("open_job_editor", {
                      folderPath: job.folder_path,
                      editor: preferredEditor,
                      jobName: job.job_name ?? "default",
                      fileName: previewFile,
                    });
                  }}
                >
                  Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Configuration */}
      <div className="field-group">
        <button
          onClick={() => setConfigCollapsed((v) => !v)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: 0,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
          }}
          className="field-group-title"
        >
          <span style={{ fontFamily: "monospace", fontSize: 9 }}>
            {configCollapsed ? "\u25B6" : "\u25BC"}
          </span>
          Configuration
        </button>
        {!configCollapsed && (
          <>
            <DetailRow label="Type" value={job.job_type} />
            <DetailRow label="Enabled" value={job.enabled ? "Yes" : "No"} />
            {job.cron ? (
              <>
                <DetailRow label="Schedule" value={describeCron(job.cron)} />
                <DetailRow label="Cron" value={job.cron} mono />
              </>
            ) : (
              <DetailRow label="Schedule" value="Manual" />
            )}
            {job.group && job.group !== "default" && (
              <DetailRow label="Group" value={job.group} />
            )}
            {job.job_type === "folder" && job.folder_path && (
              <DetailRow label="Folder" value={job.folder_path} mono />
            )}
            {job.job_type === "binary" && (
              <DetailRow label="Path" value={job.path} mono />
            )}
            {job.args.length > 0 && (
              <DetailRow label="Args" value={job.args.join(" ")} mono />
            )}
            {job.work_dir && (
              <DetailRow label="Work dir" value={job.work_dir} mono />
            )}
          </>
        )}
      </div>

      {/* Runtime */}
      {(job.tmux_session || job.aerospace_workspace || job.notify_target !== "none") && (
        <div className="field-group">
          <span className="field-group-title">Runtime</span>
          {job.tmux_session && (
            <DetailRow label="Tmux session" value={job.tmux_session} mono />
          )}
          {job.aerospace_workspace && (
            <DetailRow label="Aerospace workspace" value={job.aerospace_workspace} />
          )}
          {job.notify_target !== "none" && (
            <DetailRow label="Notify target" value={job.notify_target === "telegram" ? "Telegram" : "App"} />
          )}
          {job.notify_target === "telegram" && job.telegram_chat_id && (
            <>
              <DetailRow label="Telegram chat" value={String(job.telegram_chat_id)} mono />
              <DetailRow
                label="Notifications"
                value={
                  [
                    job.telegram_notify.start && "start",
                    job.telegram_notify.working && "working",
                    job.telegram_notify.logs && "logs",
                    job.telegram_notify.finish && "finish",
                  ].filter(Boolean).join(", ") || "none"
                }
              />
            </>
          )}
        </div>
      )}

      {/* Secrets */}
      {job.secret_keys.length > 0 && (
        <div className="field-group">
          <span className="field-group-title">Secrets</span>
          {job.secret_keys.map((key) => (
            <DetailRow key={key} label={key} value="(set)" mono />
          ))}
        </div>
      )}
    </>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "var(--text-secondary)", minWidth: 120, flexShrink: 0 }}>{label}</span>
      {mono ? <code style={{ flex: 1 }}>{value}</code> : <span style={{ flex: 1 }}>{value}</span>}
    </div>
  );
}

function ParamsOverlay({
  job,
  values,
  onChange,
  onRun,
  onCancel,
}: {
  job: Job;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h3 style={{ marginBottom: 12 }}>Run: {job.name}</h3>
        <p className="text-secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Fill in all parameters before running.
        </p>
        {job.params.map((key) => (
          <div key={key} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: "block" }}>
              {key}
            </label>
            <input
              className="input"
              type="text"
              value={values[key] ?? ""}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") onRun(); }}
              placeholder={`{${key}}`}
              autoFocus={key === job.params[0]}
            />
          </div>
        ))}
        <div className="btn-group" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onRun}
            disabled={job.params.some((k) => !values[k]?.trim())}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
