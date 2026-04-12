import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job } from "../../../types";

interface UseJobImportParams {
  isNew: boolean;
  defaultDirectionsTemplate: string;
  contentSetters: {
    setInlineContent: (v: string) => void;
    setInlineLoaded: (v: boolean) => void;
    setCwtEdited: (v: boolean) => void;
    setSharedContent: (v: string) => void;
    setSharedLoaded: (v: boolean) => void;
  };
}

export function useJobImport({ isNew, defaultDirectionsTemplate, contentSetters }: UseJobImportParams) {
  const [existingJobs, setExistingJobs] = useState<Job[]>([]);
  const [showImportPicker, setShowImportPicker] = useState(false);

  useEffect(() => {
    if (isNew) {
      invoke<Job[]>("get_jobs").then(setExistingJobs).catch(() => {});
    }
  }, []);

  const importableJobs = existingJobs.filter((j) => j.job_type === "job");

  const handleImportJob = async (source: Job) => {
    const jn = source.job_id ?? "default";
    const [jobMd, cwtMd] = await Promise.all([
      invoke<string>("read_cwt_entry_at", { folderPath: source.folder_path, jobId: jn, slug: source.slug }).catch(() => ""),
      invoke<string>("read_cwt_shared_at", { folderPath: source.folder_path!, slug: source.slug }).catch(() => ""),
    ]);
    contentSetters.setInlineContent(jobMd);
    contentSetters.setInlineLoaded(true);
    contentSetters.setCwtEdited(!!jobMd && jobMd.trim() !== defaultDirectionsTemplate.trim());
    contentSetters.setSharedContent(cwtMd);
    contentSetters.setSharedLoaded(true);
    setShowImportPicker(false);
  };

  return {
    existingJobs,
    importableJobs,
    showImportPicker,
    setShowImportPicker,
    handleImportJob,
  };
}
