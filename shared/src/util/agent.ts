import { defaultAgentEffort } from "../types/process";
import type { AgentEffort, ProcessProvider } from "../types/process";

export function labelForProvider(provider: ProcessProvider | null | undefined): string {
  switch (provider) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    case "shell":
      return "Terminal";
    default:
      return "Agent";
  }
}

export function compactModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "";
  const flagStart = modelId.search(/\s+(?:-c|--(?:model|effort)|model_reasoning_effort=)/);
  const cleanModelId = flagStart >= 0 ? modelId.slice(0, flagStart) : modelId;
  const model = cleanModelId.trim().split("/").pop() ?? cleanModelId;
  return model
    .replace(/^gpt-[0-9.]+-/, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

export function modelPickerLabel(modelId: string | null | undefined, fallback: string): string {
  return compactModelLabel(modelId) || fallback;
}

export function agentSelectionLabel(
  provider: ProcessProvider | null | undefined,
  modelId: string | null | undefined,
  effort?: AgentEffort | string | null,
): string {
  const model = compactModelLabel(modelId);
  const base = model || labelForProvider(provider);
  const embeddedEffort = modelId?.match(/(?:model_reasoning_effort=|--effort\s+)(low|medium|high|xhigh|max)\b/)?.[1];
  const effectiveEffort = effort ?? embeddedEffort ?? defaultAgentEffort(provider, modelId);
  return effectiveEffort ? `${base}-${effectiveEffort}` : base;
}
