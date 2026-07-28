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

const EFFORT_LABELS: Record<string, string> = {
  low: "lo",
  medium: "md",
  high: "hi",
  xhigh: "xh",
  max: "mx",
};

const PROVIDER_LABELS: Partial<Record<ProcessProvider, string>> = {
  claude: "cla",
  codex: "cdx",
  opencode: "oc",
  antigravity: "ag",
  shell: "term",
};

function abbreviatedModelLabel(modelId: string | null | undefined, maxLength: number): string {
  if (!modelId || maxLength <= 0) return "";
  const flagStart = modelId.search(/\s+(?:-c|--(?:model|effort)|model_reasoning_effort=)/);
  const cleanModelId = (flagStart >= 0 ? modelId.slice(0, flagStart) : modelId)
    .trim()
    .split("/")
    .pop()
    ?.replace(/-\d{8}$/, "")
    .toLowerCase() ?? "";
  if (cleanModelId.length <= maxLength) return cleanModelId;

  const parts = cleanModelId
    .replace(/^(?:claude|anthropic|openai|codex|gemini|google|gpt)[-_]?/, "")
    .split(/[-_.\s]+/)
    .filter(Boolean);
  const numbers = parts.filter((part) => /^\d+$/.test(part));
  const words = parts.filter((part) => !/^\d+$/.test(part));
  const version = numbers.length > 0 ? numbers.join(".") : "";
  const family = words.map((part) => part[0]).join("");

  // Family initial + version + variant initial keeps the distinguishing pieces:
  // gpt-5.6-sol -> s5.6, claude-opus-4.8 -> o4.8.
  const semantic = `${family[0] ?? ""}${version}${family.slice(1)}`;
  if (semantic.length <= maxLength && semantic) return semantic;

  const numericSuffix = `${version}${family.slice(-1)}`;
  if (numericSuffix.length <= maxLength && numericSuffix) return numericSuffix;

  return (semantic || cleanModelId).slice(-maxLength);
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

export function compactAgentSelectionLabel(
  provider: ProcessProvider | null | undefined,
  modelId: string | null | undefined,
  effort?: AgentEffort | string | null,
): string {
  const embeddedEffort = modelId?.match(/(?:model_reasoning_effort=|--effort\s+)(low|medium|high|xhigh|max)\b/)?.[1];
  const effectiveEffort = effort ?? embeddedEffort ?? defaultAgentEffort(provider, modelId);
  const effortLabel = effectiveEffort ? (EFFORT_LABELS[effectiveEffort] ?? effectiveEffort[0]) : "";
  const suffix = effortLabel ? `-${effortLabel}` : "";
  const model = abbreviatedModelLabel(modelId, 7 - suffix.length);
  const providerLabel = provider ? PROVIDER_LABELS[provider] : undefined;
  const base = model || providerLabel || abbreviatedModelLabel(labelForProvider(provider), 7 - suffix.length);
  return `${base}${suffix}`.slice(0, 7);
}

export function compactProcessModelLabel(modelId: string | null | undefined): string {
  return abbreviatedModelLabel(modelId, 7);
}
