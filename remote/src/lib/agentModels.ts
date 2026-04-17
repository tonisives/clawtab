import type { ProcessProvider, AgentModelOption } from "@clawtab/shared";

function labelForProvider(provider: ProcessProvider): string {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "shell": return "Shell";
  }
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "o3": "o3",
  "o4-mini": "o4-mini",
};

export function labelForProviderModel(provider: ProcessProvider, model: string | null | undefined): string {
  if (!model) return labelForProvider(provider);
  const displayName = MODEL_DISPLAY_NAMES[model] ?? model;
  return `${labelForProvider(provider)} (${displayName})`;
}

export const BUILTIN_MODELS: AgentModelOption[] = [
  { provider: "claude", modelId: "claude-opus-4-7", label: "Claude Code (Opus 4.7)" },
  { provider: "claude", modelId: "claude-opus-4-6", label: "Claude Code (Opus 4.6)" },
  { provider: "claude", modelId: "claude-sonnet-4-6", label: "Claude Code (Sonnet 4.6)" },
  { provider: "claude", modelId: "claude-haiku-4-5", label: "Claude Code (Haiku 4.5)" },
  { provider: "codex", modelId: "gpt-5.4", label: "Codex (GPT-5.4)" },
  { provider: "codex", modelId: "gpt-5.4-mini", label: "Codex (GPT-5.4 Mini)" },
  { provider: "codex", modelId: "gpt-5.3-codex", label: "Codex (GPT-5.3 Codex)" },
  { provider: "codex", modelId: "o3", label: "Codex (o3)" },
  { provider: "codex", modelId: "o4-mini", label: "Codex (o4-mini)" },
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
      const builtin = BUILTIN_MODELS.find((b) => b.provider === provider && b.modelId === null);
      options.push(builtin ?? { provider, modelId: null, label: labelForProvider(provider) });
      continue;
    }
    for (const modelId of enabled) {
      const builtin = BUILTIN_MODELS.find((b) => b.provider === provider && b.modelId === modelId);
      options.push(builtin ?? { provider, modelId, label: labelForProviderModel(provider, modelId) });
    }
  }
  return options;
}
