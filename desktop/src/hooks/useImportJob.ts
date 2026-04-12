import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Job } from "../types";

type ImportState =
  | null
  | { step: "pick-dest"; source: string; jobId: string }
  | { step: "confirm-duplicate"; source: string; destCwt: string; jobId: string };

export function useImportJob(jobs: Job[], reload: () => Promise<void>, importCwtKey?: number) {
  const [importState, setImportState] = useState<ImportState>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const lastHandledImportCwtKeyRef = useRef<number | undefined>(undefined);

  const doImport = useCallback(async (source: string, destCwt: string, jobId: string) => {
    try {
      await invoke("import_job_folder", { source, destCwt, jobId });
      await reload();
      setImportState(null);
      setImportError(null);
    } catch (e) {
      setImportError(typeof e === "string" ? e : String(e));
    }
  }, [reload]);

  const pickDestAndImport = useCallback(async (source: string, jobId: string) => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (!selected) return;
    const picked = (selected as string).replace(/\/+$/, "");
    const existing = jobs.find(
      (j) => j.folder_path === picked && j.job_id === jobId,
    );
    if (existing) {
      setImportState({ step: "confirm-duplicate", source, destCwt: picked, jobId });
    } else {
      await doImport(source, picked, jobId);
    }
  }, [jobs, doImport]);

  const handleImportCwt = useCallback(async () => {
    setImportError(null);
    const selected = await open({ directory: true, title: "Select project folder (contains job.md)" });
    if (!selected) return;

    const source = selected as string;
    const parts = source.replace(/\/$/, "").split("/");
    const jobId = parts[parts.length - 1];

    const dest = source.replace(/\/$/, "");
    const existing = jobs.find(
      (j) => j.folder_path === dest && j.job_id === jobId,
    );
    if (existing) {
      setImportState({ step: "confirm-duplicate", source, destCwt: dest, jobId });
    } else {
      await doImport(source, dest, jobId);
    }
  }, [jobs, doImport]);

  const handleImportPickDest = useCallback(async () => {
    if (!importState || importState.step !== "pick-dest") return;
    await pickDestAndImport(importState.source, importState.jobId);
  }, [importState, pickDestAndImport]);

  const handleImportDuplicate = useCallback(async () => {
    if (!importState || importState.step !== "confirm-duplicate") return;
    await pickDestAndImport(importState.source, importState.jobId);
  }, [importState, pickDestAndImport]);

  useEffect(() => {
    if (!importCwtKey || importCwtKey <= 0) return;
    if (lastHandledImportCwtKeyRef.current === importCwtKey) return;
    lastHandledImportCwtKeyRef.current = importCwtKey;
    handleImportCwt();
  }, [importCwtKey, handleImportCwt]);

  return {
    importState,
    setImportState,
    importError,
    setImportError,
    handleImportCwt,
    handleImportPickDest,
    handleImportDuplicate,
  };
}
