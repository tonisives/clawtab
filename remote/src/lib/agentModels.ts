import { CURRENT_AGENT_MODEL_OPTIONS, isSyntheticAgentModel } from "@clawtab/shared";
import type { ProcessProvider, AgentModelOption } from "@clawtab/shared";

function labelForProvider(provider: ProcessProvider): string {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "antigravity": return "Antigravity";
    case "shell": return "Shell";
  }
}

export function labelForProviderModel(provider: ProcessProvider, model: string | null | undefined): string {
  if (!model) return labelForProvider(provider);
  return `${labelForProvider(provider)} (${model})`;
}

/** Bare provider entries used as fallback when a provider has no enabled models. */
export const BARE_PROVIDER_OPTIONS: AgentModelOption[] = [
  { provider: "claude", modelId: null, label: "Claude Code" },
  { provider: "codex", modelId: null, label: "Codex" },
  { provider: "opencode", modelId: null, label: "OpenCode" },
  { provider: "antigravity", modelId: null, label: "Antigravity" },
];

export function buildModelOptions(
  availableProviders: ProcessProvider[],
  enabledModels: Record<string, string[]>,
): AgentModelOption[] {
  const options: AgentModelOption[] = [];
  for (const provider of availableProviders) {
    const enabled = (enabledModels[provider] ?? []).filter((modelId) => !isSyntheticAgentModel(modelId));
    const current = CURRENT_AGENT_MODEL_OPTIONS.filter((option) => option.provider === provider);
    // An explicit empty selection must stay empty. Only unconfigured providers use defaults.
    let selected = enabledModels[provider] === undefined
      ? current.flatMap((option) => option.modelId ? [option.modelId] : [])
      : enabled;
    let modelIds = Array.from(new Set(selected));
    if (modelIds.length === 0 && enabledModels[provider] !== undefined && provider !== "shell") continue;
    if (modelIds.length === 0) {
      const bare = BARE_PROVIDER_OPTIONS.find((b) => b.provider === provider);
      options.push(bare ?? { provider, modelId: null, label: labelForProvider(provider) });
      continue;
    }
    for (const modelId of modelIds) {
      const known = current.find((option) => option.modelId === modelId);
      options.push({ provider, modelId, label: known?.label ?? labelForProviderModel(provider, modelId) });
    }
  }
  // Catalog ordering applies across providers, so Astra leads the top-level picker.
  return options.sort((left, right) => {
    let leftRank = CURRENT_AGENT_MODEL_OPTIONS.findIndex((option) => option.provider === left.provider && option.modelId === left.modelId);
    let rightRank = CURRENT_AGENT_MODEL_OPTIONS.findIndex((option) => option.provider === right.provider && option.modelId === right.modelId);
    if (leftRank >= 0 || rightRank >= 0) return (leftRank < 0 ? Infinity : leftRank) - (rightRank < 0 ? Infinity : rightRank);
    return (right.modelId ?? "").localeCompare(left.modelId ?? "", undefined, { numeric: true });
  });
}
