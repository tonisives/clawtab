import type { AgentEffort, ProcessProvider } from "@clawtab/shared";
import { AgentSelector, agentSelectionLabel, defaultAgentEffort } from "@clawtab/shared";
import type { Job } from "../../../types";
import { buildModelOptions } from "../utils";

interface ProviderFieldProps {
  form: Job;
  isNew: boolean;
  startedAsShellJob: boolean;
  availableProviders: ProcessProvider[];
  defaultProvider: ProcessProvider;
  defaultModel: string | null;
  enabledModels: Record<string, string[]>;
  handleProviderChange: (provider: ProcessProvider | null, model?: string | null, effort?: AgentEffort | null) => void;
}

export function ProviderField({
  form, isNew, startedAsShellJob, availableProviders,
  defaultProvider, defaultModel, enabledModels, handleProviderChange,
}: ProviderFieldProps) {
  if (form.job_type !== "claude" && form.job_type !== "job") return null;

  const allOptions = buildModelOptions(availableProviders, enabledModels);
  const currentProvider = form.agent_provider ?? null;
  const currentModel = form.agent_model ?? null;
  const isDefault = currentProvider === null && currentModel === null && form.agent_effort == null;
  const options = allOptions.filter((option) => {
    if (isDefault && option.provider === defaultProvider && (option.modelId ?? null) === (defaultModel ?? null)) return false;
    if (!isNew && !startedAsShellJob && option.provider === "shell") return false;
    return true;
  });

  return (
    <div className="form-group">
      <label>Agent</label>
      <AgentSelector
        modelOptions={options}
        provider={currentProvider}
        model={currentModel}
        effort={form.agent_effort ?? defaultAgentEffort(currentProvider, currentModel)}
        includeDefault
        defaultLabel={`${agentSelectionLabel(defaultProvider, defaultModel)} (default)`}
        includeShell={isNew || startedAsShellJob}
        fullWidth
        onSelectDefault={() => handleProviderChange(null, null, null)}
        onChange={(selection) => handleProviderChange(selection.provider, selection.modelId, selection.effort)}
      />
      <span className="hint">
        Pick which agent, model, and effort runs this job.
      </span>
    </div>
  );
}
