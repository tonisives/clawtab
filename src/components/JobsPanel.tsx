import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, Job, JobStatus, RunRecord } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog, DeleteButton } from "./ConfirmDialog";
import { GearIcon } from "./icons";
import { LogViewer } from "./LogViewer";

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

function StatusBadge({ status }: { status: JobStatus | undefined }) {
  if (!status || status.state === "idle") {
    return <span className="status-badge status-idle">idle</span>;
  }
  if (status.state === "running") {
    return <span className="status-badge status-running">running</span>;
  }
  if (status.state === "success") {
    return <span className="status-badge status-success">success</span>;
  }
  if (status.state === "failed") {
    return (
      <span className="status-badge status-failed">
        failed ({status.exit_code})
      </span>
    );
  }
  if (status.state === "paused") {
    return <span className="status-badge status-paused">paused</span>;
  }
  return null;
}

function groupJobs(jobs: Job[]): Map<string, Job[]> {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const group = job.group || "default";
    const list = groups.get(group) ?? [];
    list.push(job);
    groups.set(group, list);
  }
  return groups;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function useJobRuns(jobName: string) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);

  const load = async () => {
    try {
      const loaded = await invoke<RunRecord[]>("get_job_runs", { jobName });
      setRuns(loaded);
    } catch (e) {
      console.error("Failed to load runs:", e);
    }
  };

  useEffect(() => { load(); }, [jobName]);

  return { runs, reload: load };
}


export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());

  const loadJobs = async () => {
    try {
      const loaded = await invoke<Job[]>("get_jobs");
      setJobs(loaded);
    } catch (e) {
      console.error("Failed to load jobs:", e);
    }
  };

  const loadStatuses = async () => {
    try {
      const loaded = await invoke<Record<string, JobStatus>>(
        "get_job_statuses"
      );
      setStatuses(loaded);
    } catch (e) {
      console.error("Failed to load statuses:", e);
    }
  };

  useEffect(() => {
    loadJobs();
    loadStatuses();
    const interval = setInterval(loadStatuses, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async (name: string) => {
    try {
      await invoke("toggle_job", { name });
      await loadJobs();
    } catch (e) {
      console.error("Failed to toggle job:", e);
    }
  };

  const handleRunNow = async (name: string) => {
    try {
      await invoke("run_job_now", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to run job:", e);
    }
  };

  const handlePause = async (name: string) => {
    try {
      await invoke("pause_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to pause job:", e);
    }
  };

  const handleResume = async (name: string) => {
    try {
      await invoke("resume_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to resume job:", e);
    }
  };

  const handleRestart = async (name: string) => {
    try {
      await invoke("restart_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to restart job:", e);
    }
  };

  const handleOpen = async (name: string) => {
    try {
      await invoke("focus_job_window", { name });
    } catch (e) {
      console.error("Failed to open job window:", e);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await invoke("delete_job", { name });
      await loadJobs();
    } catch (e) {
      console.error("Failed to delete job:", e);
    }
  };

  const handleSave = async (job: Job) => {
    setSaveError(null);
    try {
      const renamed = editingJob && job.name !== editingJob.name;
      if (renamed) {
        await invoke("delete_job", { name: editingJob.name });
        job = { ...job, slug: "" };
      }
      await invoke("save_job", { job });
      await loadJobs();
      setEditingJob(null);
      setIsCreating(false);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setSaveError(msg);
      console.error("Failed to save job:", e);
    }
  };

  const handleDuplicate = async (job: Job) => {
    const existingNames = new Set(jobs.map((j) => j.name));
    let copyName = `${job.name}-copy`;
    let i = 2;
    while (existingNames.has(copyName)) {
      copyName = `${job.name}-copy-${i}`;
      i++;
    }
    const dup: Job = { ...job, name: copyName, slug: "", enabled: false };
    try {
      await invoke("save_job", { job: dup });
      await loadJobs();
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const toggleJobExpand = (name: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (showPicker) {
    return (
      <SamplePicker
        onCreated={() => {
          setShowPicker(false);
          loadJobs();
        }}
        onBlank={() => {
          setShowPicker(false);
          setIsCreating(true);
        }}
        onCancel={() => {
          setShowPicker(false);
        }}
      />
    );
  }

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
            setEditingJob(null);
            setIsCreating(false);
            setSaveError(null);
          }}
        />
      </>
    );
  }

  const grouped = groupJobs(jobs);
  const groupNames = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
  const isSingleGroup = groupNames.length <= 1;

  const renderJobRows = (job: Job) => {
    const status = statuses[job.name];
    const state = status?.state ?? "idle";
    const isExpanded = expandedJobs.has(job.name);

    return [
      <JobRow
        key={job.name}
        job={job}
        state={state}
        status={status}
        isExpanded={isExpanded}
        onToggleEnabled={() => handleToggle(job.name)}
        onRun={() => handleRunNow(job.name)}
        onPause={() => handlePause(job.name)}
        onResume={() => handleResume(job.name)}
        onRestart={() => handleRestart(job.name)}
        onOpen={() => handleOpen(job.name)}
        onEdit={() => setEditingJob(job)}
        onDuplicate={() => handleDuplicate(job)}
        onDelete={() => handleDelete(job.name)}
        onToggleExpand={() => toggleJobExpand(job.name)}
      />,
      state === "running" && status?.state === "running" && status.pane_id && (
        <RunningLogs key={`${job.name}-live`} jobName={job.name} />
      ),
      isExpanded && (
        <RunsPanel key={`${job.name}-runs`} jobName={job.name} />
      ),
    ];
  };

  const tableHead = (
    <thead>
      <tr>
        <th>Enabled</th>
        <th>Name</th>
        <th>Type</th>
        <th>Cron</th>
        <th>Status</th>
        <th>Actions</th>
        <th style={{ width: 20 }}></th>
      </tr>
    </thead>
  );

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Jobs</h2>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowPicker(true)}
        >
          Add Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs configured yet.</p>
          <button
            className="btn btn-primary"
            onClick={() => setShowPicker(true)}
          >
            Create your first job
          </button>
        </div>
      ) : isSingleGroup ? (
        <table className="data-table">
          {tableHead}
          <tbody>
            {jobs.flatMap(renderJobRows)}
          </tbody>
        </table>
      ) : (
        groupNames.map((group) => {
          const groupJobs = grouped.get(group) ?? [];
          const isCollapsed = collapsedGroups.has(group);
          const displayName = group === "default" ? "General" : group;

          return (
            <div key={group} style={{ marginBottom: 16 }}>
              <button
                onClick={() => toggleGroup(group)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text)",
                  cursor: "pointer",
                  padding: "4px 0",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                }}
              >
                <span style={{ fontFamily: "monospace", fontSize: 10 }}>
                  {isCollapsed ? "\u25C0" : "\u25BC"}
                </span>
                {displayName}
                <span className="text-secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                  ({groupJobs.length})
                </span>
              </button>
              {!isCollapsed && (
                <table className="data-table">
                  {tableHead}
                  <tbody>
                    {groupJobs.flatMap(renderJobRows)}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function JobRow({
  job,
  state,
  status,
  isExpanded,
  onToggleEnabled,
  onRun,
  onPause,
  onResume,
  onRestart,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleExpand,
}: {
  job: Job;
  state: string;
  status: JobStatus | undefined;
  isExpanded: boolean;
  onToggleEnabled: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleExpand: () => void;
}) {
  const { runs } = useJobRuns(job.name);
  const hasRuns = runs !== null && runs.length > 0;
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  return (
    <tr>
      <td>
        <input
          type="checkbox"
          className="toggle-switch"
          checked={job.enabled}
          onChange={onToggleEnabled}
        />
      </td>
      <td>
        {job.name}
      </td>
      <td>{job.job_type}</td>
      <td>
        <code>{job.cron || "manual"}</code>
      </td>
      <td>
        <StatusBadge status={status} />
      </td>
      <td className="actions">
        <div className="btn-group">
          {state === "running" && (
            <>
              <button className="btn btn-sm" onClick={onOpen}>
                Open
              </button>
              <button className="btn btn-sm" onClick={onPause}>
                Pause
              </button>
            </>
          )}
          {state === "paused" && (
            <button className="btn btn-success btn-sm" onClick={onResume}>
              Resume
            </button>
          )}
          {state === "failed" && (
            <button className="btn btn-success btn-sm" onClick={onRestart}>
              Restart
            </button>
          )}
          {state === "success" && (
            <button className="btn btn-success btn-sm" onClick={onRun}>
              Run Again
            </button>
          )}
          {(state === "idle" || !status) && (
            <button className="btn btn-success btn-sm" onClick={onRun}>
              Run
            </button>
          )}
        </div>
      </td>
      <td style={{ textAlign: "right", padding: "0 4px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowMenu((v) => !v)}
              title="Job actions"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "2px 4px",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <GearIcon size={16} />
            </button>
            {showMenu && (
              <div className="job-action-menu">
                <button
                  className="job-action-menu-item"
                  onClick={() => { setShowMenu(false); onEdit(); }}
                >
                  Edit
                </button>
                <button
                  className="job-action-menu-item"
                  onClick={() => { setShowMenu(false); onDuplicate(); }}
                >
                  Duplicate
                </button>
                <button
                  className="job-action-menu-item job-action-menu-item-danger"
                  onClick={() => { setShowMenu(false); setShowConfirm(true); }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          <button
            onClick={hasRuns ? onToggleExpand : undefined}
            title="Runs"
            disabled={!hasRuns}
            style={{
              background: "none",
              border: "none",
              color: hasRuns ? "var(--text-secondary)" : "var(--text-secondary)",
              opacity: hasRuns ? 1 : 0.3,
              cursor: hasRuns ? "pointer" : "default",
              padding: "2px 4px",
              fontSize: 10,
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <span style={{ fontFamily: "monospace" }}>
              {isExpanded ? "\u25BC" : "\u25C0"}
            </span>
          </button>
        </div>
      </td>
      {showConfirm && (
        <ConfirmDialog
          message={`Delete job "${job.name}"? This cannot be undone.`}
          onConfirm={() => { onDelete(); setShowConfirm(false); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </tr>
  );
}

function buildLogContent(run: RunRecord): string {
  let content = "";
  if (run.stdout) {
    content += run.stdout;
  }
  if (run.stderr) {
    if (content) content += "\n";
    content += "--- stderr ---\n" + run.stderr;
  }
  return content || "(no output)";
}

function RunningLogs({ jobName }: { jobName: string }) {
  const [logs, setLogs] = useState("");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const result = await invoke<string>("get_running_job_logs", { name: jobName });
        if (active) setLogs(result);
      } catch {
        // Job may have stopped between polls
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [jobName]);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs]);

  if (!logs) return null;

  return (
    <tr>
      <td colSpan={7} style={{ padding: "0 12px 4px", border: "none" }}>
        <pre ref={preRef} style={{
          margin: 0,
          padding: "6px 8px",
          fontSize: 11,
          lineHeight: 1.4,
          background: "var(--bg-secondary, #1a1a1a)",
          borderRadius: 4,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          height: 100,
          minHeight: 40,
          maxHeight: 400,
          resize: "vertical",
          color: "var(--text-secondary)",
        }}>{logs}</pre>
      </td>
    </tr>
  );
}

function RunsPanel({ jobName }: { jobName: string }) {
  const { runs, reload } = useJobRuns(jobName);
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    });
  }, []);

  const handleDeleteRun = async (runId: string) => {
    try {
      await invoke("delete_run", { runId });
      reload();
    } catch (e) {
      console.error("Failed to delete run:", e);
    }
  };

  const handleOpenLog = async (runId: string) => {
    try {
      await invoke("open_run_log", { runId });
    } catch (e) {
      console.error("Failed to open log:", e);
    }
  };

  const exitCodeClass = (code: number | null) => {
    if (code === null) return "running";
    if (code === 0) return "idle";
    return "error";
  };

  const exitCodeLabel = (code: number | null) => {
    if (code === null) return "running";
    if (code === 0) return "ok";
    return `exit ${code}`;
  };

  return (
    <tr>
      <td colSpan={7} style={{ padding: "0 0 8px", border: "none" }}>
        {runs === null ? (
          <span className="text-secondary" style={{ fontSize: 12, padding: "0 12px" }}>Loading...</span>
        ) : runs.length === 0 ? (
          <span className="text-secondary" style={{ fontSize: 12, padding: "0 12px" }}>No run history</span>
        ) : (
          <table className="data-table runs-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ fontSize: 10, padding: "4px 12px" }}>Status</th>
                <th style={{ fontSize: 10, padding: "4px 12px" }}>Trigger</th>
                <th style={{ fontSize: 10, padding: "4px 12px" }}>Started</th>
                <th style={{ fontSize: 10, padding: "4px 12px" }}>Duration</th>
                <th style={{ fontSize: 10, padding: "4px 12px" }}>Actions</th>
                <th style={{ width: 28, padding: "4px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const duration = run.finished_at
                  ? `${((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000).toFixed(1)}s`
                  : "...";
                const isLogExpanded = expandedRunId === run.id;

                return [
                  <tr key={run.id}>
                    <td>
                      <span className={`status-dot ${exitCodeClass(run.exit_code)}`} />
                      {exitCodeLabel(run.exit_code)}
                    </td>
                    <td>{run.trigger}</td>
                    <td>{formatTime(run.started_at)}</td>
                    <td>{duration}</td>
                    <td className="actions">
                      <div className="btn-group">
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 11, padding: "1px 6px" }}
                          onClick={() => setExpandedRunId(isLogExpanded ? null : run.id)}
                        >
                          Logs {isLogExpanded ? "\u25B2" : "\u25BC"}
                        </button>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", padding: "0 8px" }}>
                      <DeleteButton
                        onClick={() => setConfirmRunId(run.id)}
                        title="Delete this run"
                        size={11}
                      />
                    </td>
                  </tr>,
                  isLogExpanded && (
                    <tr key={`${run.id}-logs`}>
                      <td colSpan={6} style={{ padding: "0 12px 8px", border: "none" }}>
                        <LogViewer content={buildLogContent(run)} />
                        <button
                          className="btn btn-sm"
                          style={{ marginTop: 6, fontSize: 11 }}
                          onClick={() => handleOpenLog(run.id)}
                        >
                          Open in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
                        </button>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        )}
        {confirmRunId && (
          <ConfirmDialog
            message="Delete this run record? This cannot be undone."
            onConfirm={() => { handleDeleteRun(confirmRunId); setConfirmRunId(null); }}
            onCancel={() => setConfirmRunId(null)}
          />
        )}
      </td>
    </tr>
  );
}
