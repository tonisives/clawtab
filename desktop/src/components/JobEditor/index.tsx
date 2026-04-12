import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Job } from "../../types";
import { emptyJob, DEFAULT_SHELL_TEMPLATE, DEFAULT_TEMPLATE, type JobEditorProps } from "./types";
import { useWizardNavigation } from "./hooks/useWizardNavigation";
import { useScheduleState } from "./hooks/useScheduleState";
import { useEditorSettings } from "./hooks/useEditorSettings";
import { useSecretsAndSkills } from "./hooks/useSecretsAndSkills";
import { useContentEditor } from "./hooks/useContentEditor";
import { useJobImport } from "./hooks/useJobImport";
import { WizardLayout } from "./components/WizardLayout";
import { EditLayout } from "./components/EditLayout";

export function JobEditor({ job, onSave, onCancel, onPickTemplate, defaultGroup, defaultFolderPath, headerMode = "back" }: JobEditorProps) {
  const [form, setForm] = useState<Job>(job ?? {
    ...emptyJob,
    ...(defaultGroup ? { group: defaultGroup } : {}),
    ...(defaultFolderPath ? { folder_path: defaultFolderPath } : {}),
  });
  const [argsText, setArgsText] = useState(form.args.join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(form.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [paramInput, setParamInput] = useState("");
  const [pendingAutoYes, setPendingAutoYes] = useState(false);

  const isNew = job === null;
  const isWizard = isNew && form.job_type === "job";
  const isCloseHeader = headerMode === "close";
  const isShellJob = form.job_type === "job" && form.agent_provider === "shell";
  const startedAsShellJob = !isNew && job?.job_type === "job" && job.agent_provider === "shell";
  const defaultDirectionsTemplate = isShellJob ? DEFAULT_SHELL_TEMPLATE : DEFAULT_TEMPLATE;

  const wizard = useWizardNavigation();
  const settings = useEditorSettings({ form, setForm, isNew, isWizard });
  const schedule = useScheduleState({ form, setForm, isNew });
  const content = useContentEditor({ form, setForm, isNew, isShellJob, defaultDirectionsTemplate });
  const secrets = useSecretsAndSkills({ form, setForm, isWizard, currentStep: wizard.currentStep });
  const jobImport = useJobImport({
    isNew,
    defaultDirectionsTemplate,
    contentSetters: {
      setInlineContent: content.setInlineContent,
      setInlineLoaded: content.setInlineLoaded,
      setCwtEdited: content.setCwtEdited,
      setSharedContent: content.setSharedContent,
      setSharedLoaded: content.setSharedLoaded,
    },
  });

  const handleSubmit = async () => {
    const args = argsText
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    }
    if (isNew && form.job_type === "job" && form.folder_path) {
      const jn = form.job_id ?? "default";
      await invoke("init_cwt_folder", { folderPath: form.folder_path, jobId: jn });
      await invoke("write_cwt_entry_at", {
        folderPath: form.folder_path,
        jobId: jn,
        content: content.inlineContent,
        slug: form.slug || null,
      });
      if (content.sharedContent) {
        await invoke("write_cwt_shared_at", {
          folderPath: form.folder_path,
          content: content.sharedContent,
          slug: form.slug || null,
        });
      }
    }
    onSave({ ...form, args, env });
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose project folder" });
    if (selected) {
      const projectDir = typeof selected === "string" ? selected : selected;
      const cleanDir = projectDir.replace(/\/+$/, "");
      const folderName = cleanDir.split("/").pop() || "default";
      setForm((prev) => ({ ...prev, folder_path: cleanDir, group: folderName }));
    }
  };

  const canAdvanceFromFolder = (): boolean => {
    if (form.job_type === "job") {
      if (!form.folder_path || !form.name) return false;
      if (isWizard && !content.cwtEdited) return false;
      return true;
    }
    return !!form.name;
  };

  if (isWizard) {
    return (
      <WizardLayout
        form={form}
        setForm={setForm}
        isNew={isNew}
        isShellJob={isShellJob}
        isCloseHeader={isCloseHeader}
        startedAsShellJob={startedAsShellJob}
        onCancel={onCancel}
        handleSubmit={handleSubmit}
        canAdvanceFromFolder={canAdvanceFromFolder}
        pickFolder={pickFolder}
        wizard={wizard}
        schedule={schedule}
        content={content}
        secrets={secrets}
        settings={settings}
        jobImport={jobImport}
        paramInput={paramInput}
        setParamInput={setParamInput}
        argsText={argsText}
        setArgsText={setArgsText}
        pendingAutoYes={pendingAutoYes}
        setPendingAutoYes={setPendingAutoYes}
        onPickTemplate={onPickTemplate}
      />
    );
  }

  return (
    <EditLayout
      form={form}
      setForm={setForm}
      isNew={isNew}
      isShellJob={isShellJob}
      isCloseHeader={isCloseHeader}
      startedAsShellJob={startedAsShellJob}
      onCancel={onCancel}
      handleSubmit={handleSubmit}
      pickFolder={pickFolder}
      schedule={schedule}
      content={content}
      secrets={secrets}
      settings={settings}
      jobImport={jobImport}
      paramInput={paramInput}
      setParamInput={setParamInput}
      argsText={argsText}
      setArgsText={setArgsText}
      envText={envText}
      setEnvText={setEnvText}
      pendingAutoYes={pendingAutoYes}
      setPendingAutoYes={setPendingAutoYes}
    />
  );
}
