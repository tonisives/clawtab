import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "../../ConfirmDialog";
import { ParamsOverlay } from "../../ParamsOverlay";
import { SkillSearchDialog } from "../../SkillSearchDialog";
import { InjectSecretsDialog } from "../../InjectSecretsDialog";
import { EditTextDialog } from "../../EditTextDialog";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useImportJob } from "../../../hooks/useImportJob";
import type { useProcessEditing } from "../hooks/useProcessEditing";
import type { useViewingState } from "../hooks/useViewingState";

interface DialogsProps {
  viewing: ReturnType<typeof useViewingState>;
  autoYes: ReturnType<typeof useAutoYes>;
  importJob: ReturnType<typeof useImportJob>;
  missedCronJobs: {
    names: string[];
    runAll: () => void;
    clear: () => void;
  };
  paneDialogs: {
    skillSearchPaneId: string | null;
    setSkillSearchPaneId: (value: string | null) => void;
    injectSecretsPaneId: string | null;
    setInjectSecretsPaneId: (value: string | null) => void;
    onForkWithSecrets: (paneId: string, keys: string[]) => void;
    processEditing: ReturnType<typeof useProcessEditing>;
  };
  handleRunWithParams: () => void;
}

export function Dialogs({
  viewing,
  autoYes,
  importJob,
  missedCronJobs,
  paneDialogs,
  handleRunWithParams,
}: DialogsProps) {
  const { paramsDialog, setParamsDialog, viewingJob } = viewing;
  const {
    skillSearchPaneId,
    setSkillSearchPaneId,
    injectSecretsPaneId,
    setInjectSecretsPaneId,
    onForkWithSecrets,
    processEditing,
  } = paneDialogs;
  const { editProcessField, setEditProcessField, handleSaveProcessField } = processEditing;

  return (
    <>
      {paramsDialog && !viewingJob && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}

      {autoYes.pendingAutoYes && (
        <ConfirmDialog
          message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
          confirmLabel="Enable" confirmClassName="btn btn-sm"
        />
      )}

      {importJob.importState?.step === "pick-dest" && (
        <ConfirmDialog
          message={`"${importJob.importState.jobId}" was not auto-detected. Select a project folder to import into.`}
          onConfirm={importJob.handleImportPickDest} onCancel={() => importJob.setImportState(null)}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importJob.importState?.step === "confirm-duplicate" && (
        <ConfirmDialog
          message={`"${importJob.importState.jobId}" already exists in this project. Duplicate to a different project?`}
          onConfirm={importJob.handleImportDuplicate} onCancel={() => importJob.setImportState(null)}
          confirmLabel="Select folder" confirmClassName="btn btn-primary btn-sm"
        />
      )}

      {importJob.importError && (
        <ConfirmDialog
          message={importJob.importError}
          onConfirm={() => importJob.setImportError(null)} onCancel={() => importJob.setImportError(null)}
          confirmLabel="OK" confirmClassName="btn btn-sm"
        />
      )}

      {missedCronJobs.names.length > 0 && (
        <ConfirmDialog
          message={`${missedCronJobs.names.length} missed cron job${missedCronJobs.names.length > 1 ? "s" : ""} detected:\n\n${missedCronJobs.names.map((name) => "  - " + name).join("\n")}\n\nRun them now?`}
          onConfirm={missedCronJobs.runAll} onCancel={missedCronJobs.clear}
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
          onSave={handleSaveProcessField}
          onCancel={() => setEditProcessField(null)}
        />
      )}
    </>
  );
}
