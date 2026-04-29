import type { ProcessProvider, AgentModelOption } from "@clawtab/shared";

function labelForProvider(provider: ProcessProvider): string {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
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
];

export function buildModelOptions(
  availableProviders: ProcessProvider[],
  enabledModels: Record<string, string[]>,
): AgentModelOption[] {
  const options: AgentModelOption[] = [];
  for (const provider of availableProviders) {
    const enabled = enabledModels[provider] ?? [];
    if (enabled.length === 0) {
      const bare = BARE_PROVIDER_OPTIONS.find((b) => b.provider === provider);
      options.push(bare ?? { provider, modelId: null, label: labelForProvider(provider) });
      continue;
    }
    for (const modelId of enabled) {
      options.push({ provider, modelId, label: labelForProviderModel(provider, modelId) });
    }
  }
  return options;
}
