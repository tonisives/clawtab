import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "../../ConfirmDialog";
import { ParamsOverlay } from "../../ParamsOverlay";
import { SkillSearchDialog } from "../../SkillSearchDialog";
import { InjectSecretsDialog } from "../../InjectSecretsDialog";
import { EditTextDialog } from "../../EditTextDialog";
import type { DetectedProcess } from "@clawtab/shared";
import type { Job } from "../../../types";

interface DialogsProps {
  paramsDialog: { job: Job; values: Record<string, string> } | null;
  setParamsDialog: (v: { job: Job; values: Record<string, string> } | null) => void;
  handleRunWithParams: () => void;
  viewingJob: Job | null;
  viewingProcess: DetectedProcess | null;
  autoYesPending: { title: string } | null;
  onConfirmAutoYes: () => void;
  onCancelAutoYes: () => void;
  importState: { step: string; jobId: string } | null;
  onImportPickDest: () => void;
  onImportDuplicate: () => void;
  onCancelImport: () => void;
  importError: string | null;
  onClearImportError: () => void;
  missedCronJobs: string[];
  onRunMissedJobs: () => void;
  onClearMissedJobs: () => void;
  skillSearchPaneId: string | null;
  setSkillSearchPaneId: (v: string | null) => void;
  injectSecretsPaneId: string | null;
  setInjectSecretsPaneId: (v: string | null) => void;
  onForkWithSecrets: (paneId: string, keys: string[]) => void;
  editProcessField: {
    paneId: string;
    title: string;
    label: string;
    field: "display_name";
    initialValue: string;
    placeholder?: string;
  } | null;
  setEditProcessField: (v: null) => void;
  onSaveProcessField: (value: string) => void;
}

export function Dialogs({
  paramsDialog,
  setParamsDialog,
  handleRunWithParams,
  viewingJob,
  viewingProcess,
  autoYesPending,
  onConfirmAutoYes,
  onCancelAutoYes,
  importState,
  onImportPickDest,
  onImportDuplicate,
  onCancelImport,
  importError,
  onClearImportError,
  missedCronJobs,
  onRunMissedJobs,
  onClearMissedJobs,
  skillSearchPaneId,
  setSkillSearchPaneId,
  injectSecretsPaneId,
  setInjectSecretsPaneId,
  onForkWithSecrets,
  editProcessField,
  setEditProcessField,
  onSaveProcessField,
}: DialogsProps) {
  return (
    <>
      {paramsDialog && !viewingJob && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}

      {autoYesPending && !viewingJob && !viewingProcess && (
        <ConfirmDialog
          message={`Enable auto-yes for "${autoYesPending.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={onConfirmAutoYes} onCancel={onCancelAutoYes}
          confirmLabel="Enable" confirmClassName="btn btn-sm"
        />
      )}

      {importState?.step === "pick-dest" && (
        <ConfirmDialog
          message={`"${importState.jobId}" was not auto-detected. Select a project folder to import into.`}
          onConfirm={onImportPickDest} onCancel={onCancelImport}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importState?.step === "confirm-duplicate" && (
        <ConfirmDialog
          message={`"${importState.jobId}" already exists in this project. Duplicate to a different project?`}
          onConfirm={onImportDuplicate} onCancel={onCancelImport}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importError && (
        <ConfirmDialog
          message={importError}
          onConfirm={onClearImportError} onCancel={onClearImportError}
          confirmLabel="OK" confirmClassName="btn btn-sm"
        />
      )}

      {missedCronJobs.length > 0 && (
        <ConfirmDialog
          message={`${missedCronJobs.length} missed cron job${missedCronJobs.length > 1 ? "s" : ""} detected:\n\n${missedCronJobs.map((n) => "  - " + n).join("\n")}\n\nRun them now?`}
          onConfirm={onRunMissedJobs} onCancel={onClearMissedJobs}
          confirmLabel="Run All" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {skillSearchPaneId && (
        <SkillSearchDialog
          onSelect={(name) => {
            invoke("send_detected_process_input", { paneId: skillSearchPaneId, text: "/" + name }).catch(console.error);
            setSkillSearchPaneId(null);
          }}
          onCancel={() => setSkillSearchPaneId(null)}
        />
      )}

      {injectSecretsPaneId && (
        <InjectSecretsDialog
          onConfirm={(keys) => {
            onForkWithSecrets(injectSecretsPaneId, keys);
            setInjectSecretsPaneId(null);
          }}
          onCancel={() => setInjectSecretsPaneId(null)}
        />
      )}

      {editProcessField && (
        <EditTextDialog
          title={editProcessField.title}
          label={editProcessField.label}
          initialValue={editProcessField.initialValue}
          placeholder={editProcessField.placeholder}
          onSave={onSaveProcessField}
          onCancel={() => setEditProcessField(null)}
        />
      )}
    </>
  );
}
