import type { Job } from "../../../types";
import { ConfirmDialog } from "../../ConfirmDialog";
import type { useScheduleState } from "../hooks/useScheduleState";
import type { useContentEditor } from "../hooks/useContentEditor";
import type { useSecretsAndSkills } from "../hooks/useSecretsAndSkills";
import type { useEditorSettings } from "../hooks/useEditorSettings";
import type { useJobImport } from "../hooks/useJobImport";
import { FieldGroup } from "./FieldGroup";
import { IdentityFields } from "./IdentityFields";
import { DirectionsFields } from "./DirectionsFields";
import { ParamsFields } from "./ParamsFields";
import { ScheduleFields } from "./ScheduleFields";
import { SecretsFields } from "./SecretsFields";
import { SkillsFields } from "./SkillsFields";
import { ConfigFields } from "./ConfigFields";
import { NotificationFields } from "./NotificationFields";
import { ProviderField } from "./ProviderField";

interface EditLayoutProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  isShellJob: boolean;
  isCloseHeader: boolean;
  startedAsShellJob: boolean;
  onCancel: () => void;
  handleSubmit: () => Promise<void>;
  pickFolder: () => void;
  schedule: ReturnType<typeof useScheduleState>;
  content: ReturnType<typeof useContentEditor>;
  secrets: ReturnType<typeof useSecretsAndSkills>;
  settings: ReturnType<typeof useEditorSettings>;
  jobImport: ReturnType<typeof useJobImport>;
  paramInput: string;
  setParamInput: (v: string) => void;
  argsText: string;
  setArgsText: (v: string) => void;
  envText: string;
  setEnvText: (v: string) => void;
  pendingAutoYes: boolean;
  setPendingAutoYes: (v: boolean) => void;
}

export function EditLayout({
  form, setForm, isNew, isShellJob, isCloseHeader, startedAsShellJob,
  onCancel, handleSubmit, pickFolder,
  schedule, content, secrets, settings, jobImport,
  paramInput, setParamInput, argsText, setArgsText, envText, setEnvText,
  pendingAutoYes, setPendingAutoYes,
}: EditLayoutProps) {
  return (
    <div className="settings-section">
      <div className="section-header" style={{ justifyContent: "space-between" }}>
        {isCloseHeader ? (
          <>
            <h2>{isNew ? "Add Job" : `Edit: ${form.name}`}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleSubmit}>
                {isNew ? "Create" : "Save"}
              </button>
              <button className="panel-close-btn" onClick={onCancel} title="Close panel">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 2l10 10M12 2L2 12" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              onClick={onCancel}
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
              title={isNew ? "Back to jobs" : "Back to job"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
                <path d="M15 18l-6-6 6-6" />
              </svg>
              <h2>{isNew ? "Add Job" : `Edit: ${form.name}`}</h2>
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleSubmit}>
              {isNew ? "Create" : "Save"}
            </button>
          </>
        )}
      </div>

      <FieldGroup title="Identity">
        <IdentityFields
          form={form}
          setForm={setForm}
          isNew={isNew}
          argsText={argsText}
          setArgsText={setArgsText}
          pickFolder={pickFolder}
        />
      </FieldGroup>

      {(form.job_type === "claude" || form.job_type === "job") && (
        <FieldGroup title="Agent">
          <ProviderField
            form={form}
            isNew={isNew}
            startedAsShellJob={startedAsShellJob}
            availableProviders={settings.availableProviders}
            defaultProvider={settings.defaultProvider}
            defaultModel={settings.defaultModel}
            enabledModels={settings.enabledModels}
            handleProviderChange={content.handleProviderChange}
          />
        </FieldGroup>
      )}

      {form.job_type === "job" && form.folder_path && (
        <FieldGroup title="Directions">
          <DirectionsFields
            form={form}
            isNew={isNew}
            isShellJob={isShellJob}
            isWizard={false}
            preferredEditor={settings.preferredEditor}
            previewFile={content.previewFile}
            setPreviewFile={content.setPreviewFile}
            inlineContent={content.inlineContent}
            jobCwtContent={content.jobCwtContent}
            dragOver={content.dragOver}
            editorRef={content.editorRef}
            cwtEdited={content.cwtEdited}
            handleInlineChange={content.handleInlineChange}
            importableJobs={jobImport.importableJobs}
            showImportPicker={jobImport.showImportPicker}
            setShowImportPicker={jobImport.setShowImportPicker}
            handleImportJob={jobImport.handleImportJob}
          />
          <ParamsFields
            form={form}
            setForm={setForm}
            paramInput={paramInput}
            setParamInput={setParamInput}
            editorRef={content.editorRef}
            previewFile={content.previewFile}
            inlineContent={content.inlineContent}
            handleInlineChange={content.handleInlineChange}
          />
        </FieldGroup>
      )}

      <FieldGroup title="Schedule">
        <ScheduleFields
          form={form}
          setForm={setForm}
          {...schedule}
        />
      </FieldGroup>

      <FieldGroup title="Secrets">
        <SecretsFields form={form} {...secrets} />
      </FieldGroup>

      {!isShellJob && (
        <FieldGroup title="Skills">
          <SkillsFields
            form={form}
            availableSkills={secrets.availableSkills}
            toggleSkill={secrets.toggleSkill}
          />
        </FieldGroup>
      )}

      <FieldGroup title="Config">
        <ConfigFields
          form={form}
          setForm={setForm}
          isShellJob={isShellJob}
          envText={envText}
          setEnvText={setEnvText}
          setPendingAutoYes={setPendingAutoYes}
        />
      </FieldGroup>

      <FieldGroup title="Runtime">
        {(form.job_type === "claude" || form.job_type === "job") && (
          <div className="form-group">
            <label>Tmux Session</label>
            <input
              type="text"
              value={form.tmux_session ?? ""}
              onChange={(e) => setForm((prev) => ({ ...prev, tmux_session: e.target.value || null }))}
              onBlur={(e) => { if (isNew) settings.persistTmuxSession(e.target.value); }}
              placeholder=""
            />
          </div>
        )}
        <NotificationFields
          form={form}
          setForm={setForm}
          telegramChats={settings.telegramChats}
        />
      </FieldGroup>

      {pendingAutoYes && (
        <ConfirmDialog
          message="Enable auto-yes for this job? All future questions will be automatically accepted with 'Yes' whenever this job is running."
          onConfirm={() => {
            setForm((prev) => ({ ...prev, auto_yes: true }));
            setPendingAutoYes(false);
          }}
          onCancel={() => setPendingAutoYes(false)}
          confirmLabel="Enable"
          confirmClassName="btn btn-sm"
          autoFocusConfirm
        />
      )}
    </div>
  );
}
