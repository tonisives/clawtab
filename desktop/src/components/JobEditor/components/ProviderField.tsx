import type { ProcessProvider } from "@clawtab/shared";
import type { Job } from "../../../types";
import {
  buildModelOptions,
  decodeProviderModel,
  encodeProviderModel,
  labelForProviderModel,
} from "../utils";

interface ProviderFieldProps {
  form: Job;
  isNew: boolean;
  startedAsShellJob: boolean;
  availableProviders: ProcessProvider[];
  defaultProvider: ProcessProvider;
  defaultModel: string | null;
  enabledModels: Record<string, string[]>;
  handleProviderChange: (provider: ProcessProvider | null, model?: string | null) => void;
}

export function ProviderField({
  form, isNew, startedAsShellJob, availableProviders,
  defaultProvider, defaultModel, enabledModels, handleProviderChange,
}: ProviderFieldProps) {
  if (form.job_type !== "claude" && form.job_type !== "job") return null;

  const allOptions = buildModelOptions(availableProviders, enabledModels);
  const currentProvider = form.agent_provider ?? null;
  const currentModel = form.agent_model ?? null;
  const isDefault = currentProvider === null
    || (currentProvider === defaultProvider && (currentModel ?? null) === (defaultModel ?? null));
  const selectedValue = isDefault ? "" : encodeProviderModel(currentProvider!, currentModel);

  // Filter: exclude the default combo, and for non-new non-shell jobs exclude shell
  const options = allOptions.filter((opt) => {
    if (opt.provider === defaultProvider && (opt.modelId ?? null) === (defaultModel ?? null)) return false;
    if (!isNew && !startedAsShellJob && opt.provider === "shell") return false;
    return true;
  });

  return (
    <div className="form-group">
      <label>Agent</label>
      <select
        value={selectedValue}
        onChange={(e) => {
          const val = e.target.value;
          if (!val) {
            handleProviderChange(null, null);
          } else {
            const { provider, model } = decodeProviderModel(val);
            handleProviderChange(provider, model);
          }
        }}
      >
        <option value="">{labelForProviderModel(defaultProvider, defaultModel)} (default)</option>
        {options.map((opt) => {
          const val = encodeProviderModel(opt.provider, opt.modelId);
          return (
            <option key={val} value={val}>
              {opt.label}
            </option>
          );
        })}
      </select>
      <span className="hint">
        Pick which agent and model runs this job.
      </span>
    </div>
  );
}
