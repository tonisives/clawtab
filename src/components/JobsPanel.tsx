import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job } from "../types";
import { JobEditor } from "./JobEditor";

export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
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

  useEffect(() => {
    loadJobs();
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
    } catch (e) {
      console.error("Failed to run job:", e);
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
        <button className="btn btn-primary btn-sm" onClick={() => setIsCreating(true)}>
          Add Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs configured yet.</p>
          <button className="btn btn-primary" onClick={() => setIsCreating(true)}>
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
                <td className="actions">
                  <div className="btn-group">
                    <button
                      className="btn btn-success btn-sm"
                      onClick={() => handleRunNow(job.name)}
                    >
                      Run
                    </button>
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
