import { useState } from "react";
import type { Job } from "../../../types";
import { ConfirmDialog } from "../../ConfirmDialog";
import type { useScheduleState } from "../hooks/useScheduleState";
import type { useContentEditor } from "../hooks/useContentEditor";
import type { useSecretsAndSkills } from "../hooks/useSecretsAndSkills";
import type { useEditorSettings } from "../hooks/useEditorSettings";
import type { useJobImport } from "../hooks/useJobImport";
import { FieldGroup, CollapsibleFieldGroup } from "./FieldGroup";
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
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);
  const [tmuxExpanded, setTmuxExpanded] = useState(false);
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

      <FieldGroup title="Config">
        <ConfigFields
          form={form}
          setForm={setForm}
          isShellJob={isShellJob}
          envText={envText}
          setEnvText={setEnvText}
          setPendingAutoYes={setPendingAutoYes}
          existingGroups={settings.existingGroups}
        />
        {(form.job_type === "claude" || form.job_type === "job") && (
          <CollapsibleFieldGroup
            title="Tmux Session"
            expanded={tmuxExpanded}
            onToggle={() => setTmuxExpanded(!tmuxExpanded)}
            badge={form.tmux_session ? <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: "normal" }}>{form.tmux_session}</span> : null}
          >
            <div className="form-group">
              <input
                type="text"
                value={form.tmux_session ?? ""}
                onChange={(e) => setForm((prev) => ({ ...prev, tmux_session: e.target.value || null }))}
                onBlur={(e) => { if (isNew) settings.persistTmuxSession(e.target.value); }}
                placeholder=""
              />
              <span className="hint">Override the default cwt session name. Leave empty to use the default.</span>
            </div>
          </CollapsibleFieldGroup>
        )}
      </FieldGroup>

      <CollapsibleFieldGroup
        title="Secrets"
        expanded={secretsExpanded}
        onToggle={() => setSecretsExpanded(!secretsExpanded)}
        badge={form.secret_keys.length > 0 ? <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: "normal" }}>{form.secret_keys.join(", ")}</span> : null}
      >
        <SecretsFields form={form} {...secrets} />
      </CollapsibleFieldGroup>

      {!isShellJob && (
        <CollapsibleFieldGroup
          title="Skills"
          expanded={skillsExpanded}
          onToggle={() => setSkillsExpanded(!skillsExpanded)}
          badge={form.skill_paths.length > 0 ? <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: "normal" }}>{form.skill_paths.map(p => p.split("/").pop() || p).join(", ")}</span> : null}
        >
          <SkillsFields
            form={form}
            availableSkills={secrets.availableSkills}
            toggleSkill={secrets.toggleSkill}
          />
        </CollapsibleFieldGroup>
      )}

      <CollapsibleFieldGroup title="Notifications" expanded={notificationsExpanded} onToggle={() => setNotificationsExpanded(!notificationsExpanded)}>
        <NotificationFields
          form={form}
          setForm={setForm}
          telegramChats={settings.telegramChats}
        />
      </CollapsibleFieldGroup>

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
