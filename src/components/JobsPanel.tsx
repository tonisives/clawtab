import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, JobStatus, RunRecord } from "../types";
import { JobEditor } from "./JobEditor";
import { ConfirmDialog, DeleteButton } from "./ConfirmDialog";

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

async function openRun(jobName: string, run: RunRecord) {
  try {
    await invoke("focus_job_window", { name: jobName });
    return;
  } catch {
    // tmux window doesn't exist, open the log file
  }
  try {
    await invoke("open_run_log", { runId: run.id });
  } catch (e) {
    console.error("Failed to open run log:", e);
  }
}

export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
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
        onEdit={() => setEditingJob(job)}
        onDelete={() => handleDelete(job.name)}
        onToggleExpand={() => toggleJobExpand(job.name)}
      />,
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
          onClick={() => setIsCreating(true)}
        >
          Add Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs configured yet.</p>
          <button
            className="btn btn-primary"
            onClick={() => setIsCreating(true)}
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
                <span style={{ fontSize: 10, transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
                  &#9660;
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
  onEdit,
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
  onEdit: () => void;
  onDelete: () => void;
  onToggleExpand: () => void;
}) {
  const { runs } = useJobRuns(job.name);
  const hasRuns = runs !== null && runs.length > 0;
  const [showConfirm, setShowConfirm] = useState(false);

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
        {job.job_name && job.job_name !== "default" && (
          <span className="text-secondary" style={{ fontSize: 11, marginLeft: 4 }}>
            ({job.job_name})
          </span>
        )}
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
            <button className="btn btn-sm" onClick={onPause}>
              Pause
            </button>
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
          <button className="btn btn-sm" onClick={onEdit}>
            Edit
          </button>
        </div>
      </td>
      <td style={{ textAlign: "right", padding: "0 4px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          {hasRuns && (
            <button
              onClick={onToggleExpand}
              title="Runs"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "2px 4px",
                fontSize: 10,
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <span style={{
                transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
              }}>
                &#9660;
              </span>
            </button>
          )}
          <DeleteButton
            onClick={() => setShowConfirm(true)}
            title="Delete job"
          />
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

function RunsPanel({ jobName }: { jobName: string }) {
  const { runs, reload } = useJobRuns(jobName);
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null);

  useEffect(() => { reload(); }, []);

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

                return (
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
                          onClick={() => openRun(jobName, run)}
                        >
                          View
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 11, padding: "1px 6px" }}
                          onClick={() => handleOpenLog(run.id)}
                          title="Open log in editor"
                        >
                          Logs
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
                  </tr>
                );
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
