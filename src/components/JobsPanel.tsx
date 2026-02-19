import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, JobStatus } from "../types";
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

export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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
      // Poll status quickly after triggering
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to run job:", e);
    }
  };

  const handleOpenWindow = async (name: string) => {
    try {
      await invoke("focus_job_window", { name });
    } catch (e) {
      // If focus fails (window doesn't exist), open a terminal instead
      try {
        await invoke("open_job_terminal", { name });
      } catch (e2) {
        console.error("Failed to open terminal:", e2);
      }
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
    try {
      await invoke("save_job", { job });
      setEditingJob(null);
      setIsCreating(false);
      await loadJobs();
    } catch (e) {
      console.error("Failed to save job:", e);
    }
  };

  if (editingJob || isCreating) {
    return (
      <JobEditor
        job={editingJob}
        onSave={handleSave}
        onCancel={() => {
          setEditingJob(null);
          setIsCreating(false);
        }}
      />
    );
  }

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
      ) : (
        <table className="data-table">
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
          <tbody>
            {jobs.map((job) => (
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
                  <code>{job.cron}</code>
                </td>
                <td>
                  <StatusBadge status={statuses[job.name]} />
                </td>
                <td className="actions">
                  <div className="btn-group">
                    {(() => {
                      const status = statuses[job.name];
                      const state = status?.state ?? "idle";
                      const isTmuxJob = job.job_type === "claude" || job.job_type === "folder";

                      return (
                        <>
                          {state === "running" && (
                            <>
                              {isTmuxJob && (
                                <button className="btn btn-sm" onClick={() => handleOpenWindow(job.name)}>
                                  Open
                                </button>
                              )}
                              <button className="btn btn-sm" onClick={() => handlePause(job.name)}>
                                Pause
                              </button>
                            </>
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
                          {isTmuxJob && state !== "running" && (
                            <button className="btn btn-sm" onClick={() => handleOpenWindow(job.name)}>
                              Open
                            </button>
                          )}
                        </>
                      );
                    })()}
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
