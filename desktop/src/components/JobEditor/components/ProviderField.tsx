import type { ProcessProvider } from "@clawtab/shared";
import type { Job } from "../../../types";
import { labelForProvider } from "../utils";

interface ProviderFieldProps {
  form: Job;
  isNew: boolean;
  startedAsShellJob: boolean;
  availableProviders: ProcessProvider[];
  defaultProvider: ProcessProvider;
  handleProviderChange: (provider: ProcessProvider | null) => void;
}

export function ProviderField({
  form, isNew, startedAsShellJob, availableProviders,
  defaultProvider, handleProviderChange,
}: ProviderFieldProps) {
  if (form.job_type !== "claude" && form.job_type !== "job") return null;

  const knownProviders = availableProviders.includes("claude")
    || availableProviders.includes("codex")
    || availableProviders.includes("opencode")
    || availableProviders.includes("shell")
    ? availableProviders
    : ([] as ProcessProvider[]);
  const currentProvider = form.agent_provider ?? null;
  const selectedProvider = currentProvider === defaultProvider ? null : currentProvider;
  const baseProviders = currentProvider && !knownProviders.includes(currentProvider)
    ? [currentProvider, ...knownProviders]
    : knownProviders;
  const providers = baseProviders
    .filter((provider) => provider !== defaultProvider)
    .filter((provider) => isNew || startedAsShellJob || provider !== "shell");

  return (
    <div className="form-group">
      <label>Agent</label>
      <select
        value={selectedProvider ?? ""}
        onChange={(e) => handleProviderChange((e.target.value || null) as ProcessProvider | null)}
      >
        <option value="">{labelForProvider(defaultProvider)} (default)</option>
        {providers.map((provider) => (
          <option key={provider} value={provider}>
            {labelForProvider(provider)}
          </option>
        ))}
      </select>
      <span className="hint">
        Pick which agent runs this job. Shell runs job.md as a command, so parameters still work as command placeholders.
      </span>
    </div>
  );
}
