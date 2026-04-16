import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { shortenPath, type DetectedProcess, type ShellPane, type useJobsCore } from "@clawtab/shared";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";

interface EditProcessField {
  paneId: string;
  title: string;
  label: string;
  field: "display_name";
  initialValue: string;
  placeholder?: string;
}

interface UseProcessEditingParams {
  core: ReturnType<typeof useJobsCore>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
}

export function useProcessEditing({ core, viewing, lifecycle }: UseProcessEditingParams) {
  const [renameProcessPaneId, setRenameProcessPaneId] = useState<string | null>(null);
  const [processRenameDrafts, setProcessRenameDrafts] = useState<Record<string, string | null>>({});
  const [editProcessField, setEditProcessField] = useState<EditProcessField | null>(null);

  const { setViewingProcess, setViewingShell } = viewing;
  const { setPendingProcess, shellPanes, setShellPanes } = lifecycle;

  const getProcessDisplayName = useCallback((process: DetectedProcess | null | undefined) => {
    if (!process) return null;
    const draft = processRenameDrafts[process.pane_id];
    if (typeof draft === "string") {
      const trimmed = draft.trim();
      return trimmed || shortenPath(process.cwd);
    }
    return process.display_name ?? process.pane_title ?? shortenPath(process.cwd);
  }, [processRenameDrafts]);

  const openRenameProcessDialog = useCallback((process: DetectedProcess) => {
    setEditProcessField({
      paneId: process.pane_id,
      title: "Edit pane title",
      label: "Title",
      field: "display_name",
      initialValue: process.display_name ?? process.pane_title ?? "",
      placeholder: shortenPath(process.cwd),
    });
  }, []);

  const openRenameShellDialog = useCallback((shell: ShellPane) => {
    setEditProcessField({
      paneId: shell.pane_id,
      title: "Edit pane title",
      label: "Title",
      field: "display_name",
      initialValue: shell.display_name ?? shell.pane_title ?? "",
      placeholder: shortenPath(shell.cwd),
    });
  }, []);

  const handleProcessRenameDraftChange = useCallback((paneId: string, value: string | null) => {
    setProcessRenameDrafts((prev) => {
      if (value === null) {
        if (!(paneId in prev)) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      }
      if (prev[paneId] === value) return prev;
      return { ...prev, [paneId]: value };
    });
  }, []);

  const handleProcessRenameStateChange = useCallback((paneId: string, editing: boolean) => {
    if (!editing && renameProcessPaneId === paneId) {
      setRenameProcessPaneId(null);
    }
  }, [renameProcessPaneId]);

  const handleSaveProcessNameInline = useCallback(async (process: DetectedProcess, name: string) => {
    const normalizedValue = name.trim() || null;
    const paneId = process.pane_id;
    try {
      setProcessRenameDrafts((prev) => {
        if (!(paneId in prev)) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      });
      if (renameProcessPaneId === paneId) setRenameProcessPaneId(null);
      core.setProcesses((prev) => prev.map((proc) => (
        proc.pane_id === paneId ? { ...proc, display_name: normalizedValue } : proc
      )));
      setViewingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await invoke("set_detected_process_display_name", {
        paneId,
        displayName: normalizedValue,
      });
      setPendingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process name:", e);
    }
  }, [core, renameProcessPaneId, setPendingProcess, setViewingProcess]);

  const handleSaveProcessField = useCallback(async (value: string) => {
    if (!editProcessField) return;
    const normalizedValue = value.trim() || null;
    const paneId = editProcessField.paneId;
    const isShell = shellPanes.some((s) => s.pane_id === paneId) && !core.processes.some((p) => p.pane_id === paneId);
    try {
      if (editProcessField.field === "display_name") {
        if (isShell) {
          setShellPanes((prev) => prev.map((shell) => (
            shell.pane_id === paneId ? { ...shell, display_name: normalizedValue } : shell
          )));
          setViewingShell((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
        } else {
          core.setProcesses((prev) => prev.map((process) => (
            process.pane_id === paneId ? { ...process, display_name: normalizedValue } : process
          )));
          setViewingProcess((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
          await invoke("set_detected_process_display_name", {
            paneId,
            displayName: normalizedValue,
          });
          setPendingProcess((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
        }
      }
      setEditProcessField(null);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process edit:", e);
    }
  }, [core, editProcessField, setPendingProcess, setShellPanes, setViewingProcess, setViewingShell, shellPanes]);

  return {
    renameProcessPaneId,
    setRenameProcessPaneId,
    processRenameDrafts,
    editProcessField,
    setEditProcessField,
    getProcessDisplayName,
    openRenameProcessDialog,
    openRenameShellDialog,
    handleProcessRenameDraftChange,
    handleProcessRenameStateChange,
    handleSaveProcessNameInline,
    handleSaveProcessField,
  };
}
