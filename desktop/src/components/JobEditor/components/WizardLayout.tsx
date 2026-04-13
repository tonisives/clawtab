import type { Job } from "../../../types";
import { ConfirmDialog } from "../../ConfirmDialog";
import { STEPS, STEP_TIPS } from "../types";
import type { useWizardNavigation } from "../hooks/useWizardNavigation";
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
import { NotificationFields } from "./NotificationFields";
import { AdvancedFields } from "./AdvancedFields";
import { ProviderField } from "./ProviderField";
import { TemplateGrid } from "./TemplateGrid";

interface WizardLayoutProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  isShellJob: boolean;
  isCloseHeader: boolean;
  startedAsShellJob: boolean;
  onCancel: () => void;
  handleSubmit: () => Promise<void>;
  canAdvanceFromFolder: () => boolean;
  pickFolder: () => void;
  wizard: ReturnType<typeof useWizardNavigation>;
  schedule: ReturnType<typeof useScheduleState>;
  content: ReturnType<typeof useContentEditor>;
  secrets: ReturnType<typeof useSecretsAndSkills>;
  settings: ReturnType<typeof useEditorSettings>;
  jobImport: ReturnType<typeof useJobImport>;
  paramInput: string;
  setParamInput: (v: string) => void;
  argsText: string;
  setArgsText: (v: string) => void;
  pendingAutoYes: boolean;
  setPendingAutoYes: (v: boolean) => void;
  onPickTemplate?: (templateId: string) => void;
}

export function WizardLayout({
  form, setForm, isNew, isShellJob, isCloseHeader, startedAsShellJob,
  onCancel, handleSubmit, canAdvanceFromFolder, pickFolder,
  wizard, schedule, content, secrets, settings, jobImport,
  paramInput, setParamInput, argsText, setArgsText,
  pendingAutoYes, setPendingAutoYes, onPickTemplate,
}: WizardLayoutProps) {
  const { currentStep, currentIdx, goNext, goBack } = wizard;

  return (
    <div className="settings-section">
      <div className="section-header" style={{ justifyContent: "space-between" }}>
        {isCloseHeader ? (
          <>
            <h2>Add Job</h2>
            <button className="panel-close-btn" onClick={onCancel} title="Close panel">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 2l10 10M12 2L2 12" />
              </svg>
            </button>
          </>
        ) : (
          <div onClick={() => { if (currentIdx > 0) { goBack(); } else { onCancel(); } }} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} title={currentIdx > 0 ? "Back to previous step" : "Back to jobs"}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <h2>Add Job</h2>
          </div>
        )}
      </div>

      <div>
        <div className="wizard-center">
          <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
            {STEPS.map((step, idx) => (
              <div
                key={step.id}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: idx <= currentIdx ? "var(--accent)" : "var(--border)",
                }}
              />
            ))}
          </div>

          <p className="text-secondary" style={{ marginBottom: 4 }}>
            Step {currentIdx + 1} of {STEPS.length}: {STEPS[currentIdx].label}
          </p>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
            {STEP_TIPS[currentStep]}
          </p>
        </div>

        {currentStep === "identity" && (
          <div className="wizard-identity-row">
            <div className="wizard-identity-col">
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
            </div>
            {form.folder_path && (
              <div className="wizard-directions-col">
                <FieldGroup title="Directions">
                  <DirectionsFields
                    form={form}
                    isNew={isNew}
                    isShellJob={isShellJob}
                    isWizard={true}
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
              </div>
            )}
          </div>
        )}

        {currentStep === "settings" && (
          <div className="wizard-center">
            <CollapsibleFieldGroup title="Schedule" expanded={wizard.scheduleExpanded} onToggle={() => wizard.setScheduleExpanded(!wizard.scheduleExpanded)}>
              <ScheduleFields
                form={form}
                setForm={setForm}
                {...schedule}
              />
            </CollapsibleFieldGroup>

            <CollapsibleFieldGroup title="Secrets" expanded={wizard.secretsExpanded} onToggle={() => wizard.setSecretsExpanded(!wizard.secretsExpanded)}>
              <SecretsFields form={form} {...secrets} />
            </CollapsibleFieldGroup>

            {!isShellJob && (
              <CollapsibleFieldGroup title="Skills" expanded={wizard.skillsExpanded} onToggle={() => wizard.setSkillsExpanded(!wizard.skillsExpanded)}>
                <SkillsFields
                  form={form}
                  availableSkills={secrets.availableSkills}
                  toggleSkill={secrets.toggleSkill}
                />
              </CollapsibleFieldGroup>
            )}

            <CollapsibleFieldGroup title="Notifications" expanded={wizard.telegramExpanded} onToggle={() => wizard.setTelegramExpanded(!wizard.telegramExpanded)}>
              <NotificationFields
                form={form}
                setForm={setForm}
                telegramChats={settings.telegramChats}
              />
            </CollapsibleFieldGroup>

            <CollapsibleFieldGroup title="Advanced" expanded={wizard.advancedExpanded} onToggle={() => wizard.setAdvancedExpanded(!wizard.advancedExpanded)}>
              <AdvancedFields
                form={form}
                setForm={setForm}
                isNew={isNew}
                isShellJob={isShellJob}
                persistTmuxSession={settings.persistTmuxSession}
                setPendingAutoYes={setPendingAutoYes}
              />
            </CollapsibleFieldGroup>
          </div>
        )}

        <div className="btn-group" style={{ marginTop: 24, justifyContent: "center" }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          {currentIdx > 0 && (
            <button className="btn" onClick={goBack}>
              Back
            </button>
          )}
          {currentStep === "settings" ? (
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={!canAdvanceFromFolder()}
            >
              Create
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={goNext}
              disabled={currentStep === "identity" && !canAdvanceFromFolder()}
            >
              Next
            </button>
          )}
        </div>

        {currentStep === "identity" && onPickTemplate && (
          <TemplateGrid
            expandedCategory={wizard.expandedCategory}
            setExpandedCategory={wizard.setExpandedCategory}
            onPickTemplate={onPickTemplate}
          />
        )}
      </div>

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
        />
      )}
    </div>
  );
}
