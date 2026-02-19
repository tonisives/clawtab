import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, JobStatus, RunRecord } from "../types";
import { JobEditor } from "./JobEditor";

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

function RunsExpander({ jobName }: { jobName: string }) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRuns = async () => {
    setLoading(true);
    try {
      const loaded = await invoke<RunRecord[]>("get_job_runs", { jobName });
      setRuns(loaded);
    } catch (e) {
      console.error("Failed to load runs:", e);
    } finally {
      setLoading(false);
    }
  };

  // Load on mount to check if there are any runs
  useEffect(() => {
    loadRuns();
  }, [jobName]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadRuns();
  };

  const handleOpenRun = async (run: RunRecord) => {
    // Try to open the tmux window first
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
  };

  // Don't render at all if no runs exist
  if (runs !== null && runs.length === 0) return null;

  return (
    <tr>
      <td colSpan={6} style={{ padding: 0, border: "none" }}>
        <button
          onClick={handleToggle}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "4px 8px",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{
            fontSize: 8,
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.15s",
          }}>
            &#9660;
          </span>
          Runs{runs !== null ? ` (${runs.length})` : ""}
        </button>
        {expanded && (
          <div style={{ padding: "0 8px 8px 24px" }}>
            {loading ? (
              <span className="text-secondary" style={{ fontSize: 12 }}>Loading...</span>
            ) : (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <tbody>
                  {(runs ?? []).map((run) => (
                    <tr key={run.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "3px 8px 3px 0", whiteSpace: "nowrap" }}>
                        {formatTime(run.started_at)}
                      </td>
                      <td style={{ padding: "3px 8px" }}>
                        {run.exit_code === null ? (
                          <span className="status-badge status-running" style={{ fontSize: 11 }}>running</span>
                        ) : run.exit_code === 0 ? (
                          <span className="status-badge status-success" style={{ fontSize: 11 }}>ok</span>
                        ) : (
                          <span className="status-badge status-failed" style={{ fontSize: 11 }}>exit {run.exit_code}</span>
                        )}
                      </td>
                      <td style={{ padding: "3px 8px", color: "var(--text-secondary)" }}>
                        {run.trigger}
                      </td>
                      <td style={{ padding: "3px 0", textAlign: "right" }}>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 11, padding: "1px 6px" }}
                          onClick={() => handleOpenRun(run)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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

    return [
      <tr key={job.name}>
        <td>
          <input
            type="checkbox"
            className="toggle-switch"
            checked={job.enabled}
            onChange={() => handleToggle(job.name)}
          />
        </td>
        <td>{job.name}</td>
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
              <button className="btn btn-sm" onClick={() => handlePause(job.name)}>
                Pause
              </button>
            )}
            {state === "paused" && (
              <button className="btn btn-success btn-sm" onClick={() => handleResume(job.name)}>
                Resume
              </button>
            )}
            {state === "failed" && (
              <button className="btn btn-success btn-sm" onClick={() => handleRestart(job.name)}>
                Restart
              </button>
            )}
            {state === "success" && (
              <button className="btn btn-success btn-sm" onClick={() => handleRunNow(job.name)}>
                Run Again
              </button>
            )}
            {(state === "idle" || !status) && (
              <button className="btn btn-success btn-sm" onClick={() => handleRunNow(job.name)}>
                Run
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => setEditingJob(job)}
            >
              Edit
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => handleDelete(job.name)}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>,
      <RunsExpander key={`${job.name}-runs`} jobName={job.name} />,
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
