import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { useJobsCore, useSplitTree } from "@clawtab/shared";
import type { Job } from "../../../types";

export function useLeafJobEditing(
  core: ReturnType<typeof useJobsCore>,
  split: ReturnType<typeof useSplitTree>,
) {
  const [editingJobs, setEditingJobs] = useState<Record<string, Job>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const startEditing = useCallback((leafId: string, job: Job) => {
    setEditingJobs((prev) => ({ ...prev, [leafId]: job }));
  }, []);

  const stopEditing = useCallback((leafId: string) => {
    setEditingJobs((prev) => {
      const next = { ...prev };
      delete next[leafId];
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      delete next[leafId];
      return next;
    });
  }, []);

  const saveJob = useCallback(async (leafId: string, originalJob: Job, job: Job) => {
    setErrors((prev) => ({ ...prev, [leafId]: null }));
    try {
      const renamed = job.name !== originalJob.name;
      if (renamed) {
        await invoke("rename_job", { oldName: originalJob.slug, job: { ...job, slug: "" } });
      } else {
        await invoke("save_job", { job });
      }

      const savedJobs = await invoke<Job[]>("get_jobs");
      const savedJob = savedJobs.find((candidate) => {
        if (candidate.slug === originalJob.slug) return true;
        return (
          candidate.name === job.name &&
          candidate.job_type === job.job_type &&
          (candidate.group || "default") === (job.group || "default") &&
          (candidate.folder_path ?? "") === (job.folder_path ?? "") &&
          (candidate.work_dir ?? "") === (job.work_dir ?? "")
        );
      }) ?? savedJobs.find((candidate) => candidate.name === job.name);

      await core.reload();
      stopEditing(leafId);
      if (savedJob && savedJob.slug !== originalJob.slug) {
        split.replaceContent({ kind: "job", slug: originalJob.slug }, { kind: "job", slug: savedJob.slug });
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setErrors((prev) => ({ ...prev, [leafId]: msg }));
      console.error("Failed to save job:", e);
    }
  }, [core, split, stopEditing]);

  return {
    getEditingJob: (leafId: string): Job | undefined => editingJobs[leafId],
    getError: (leafId: string): string | null => errors[leafId] ?? null,
    startEditing,
    stopEditing,
    saveJob,
  };
}
