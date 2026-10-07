import { CURRENT_AGENT_MODEL_OPTIONS, isSyntheticAgentModel } from "../types/process";
import type { ProcessProvider, AgentModelOption, AgentEffort } from "../types/process";

export let geminiModelEffort = (id: string | null | undefined): AgentEffort | null => {
  if (!id || !/^gemini[-\s]/i.test(id)) return null;
  return (id.match(/(?:-(low|medium|high|xhigh|max)|\s+\((low|medium|high|xhigh|max)\))$/i)?.slice(1).find(Boolean)?.toLowerCase() as AgentEffort) ?? null;
};

export let geminiBaseModel = (id: string): string => geminiModelEffort(id)
  ? id.replace(/(?:-(?:low|medium|high|xhigh|max)|\s+\((?:low|medium|high|xhigh|max)\))$/i, "")
  : id;

let modelOrder = (left: AgentModelOption, right: AgentModelOption): number => {
  let providers = ["codex", "claude", "opencode", "antigravity", "shell"];
  let providerRank = providers.indexOf(left.provider) - providers.indexOf(right.provider);
  if (providerRank) return providerRank;
  let rank = (option: AgentModelOption) => CURRENT_AGENT_MODEL_OPTIONS.findIndex((known) => known.provider === option.provider && known.modelId === option.modelId);
  let leftRank = rank(left), rightRank = rank(right);
  if (leftRank >= 0 || rightRank >= 0) return (leftRank < 0 ? Infinity : leftRank) - (rightRank < 0 ? Infinity : rightRank);
  return geminiBaseModel(right.modelId ?? "").localeCompare(geminiBaseModel(left.modelId ?? ""), undefined, { numeric: true });
};

/** Gemini catalog variants represent effort choices for one model. */
export let groupAgentModelOptions = (options: AgentModelOption[]): AgentModelOption[] => {
  let grouped = new Map<string, AgentModelOption>();
  for (let option of options) {
    let effort = option.provider === "antigravity" ? geminiModelEffort(option.modelId) : null;
    let base = effort ? geminiBaseModel(option.modelId!) : option.modelId;
    let key = `${option.provider}:${base}`;
    if (!effort) {
      if (!grouped.has(key)) grouped.set(key, { ...option });
      continue;
    }
    let entry = grouped.get(key) ?? { ...option, label: geminiBaseModel(/^gemini[-\s]/i.test(option.label) ? option.label : option.modelId!), effortModels: {} };
    entry.effortModels = { ...entry.effortModels, [effort]: option.modelId! };
    entry.modelId = entry.effortModels.medium ?? entry.effortModels.high ?? entry.effortModels.low ?? option.modelId;
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort(modelOrder);
};

let labelForProvider = (provider: ProcessProvider): string => {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "antigravity": return "Antigravity";
    case "shell": return "Shell";
  }
}

export let labelForProviderModel = (provider: ProcessProvider, model: string | null | undefined): string => {
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

export type DetectedAgentModels = Record<string, [string, string][]>;

export let hostModelCatalog = (settings?: { detected_models?: DetectedAgentModels } | null): DetectedAgentModels => {
  if (!settings) return {};
  if (settings.detected_models !== undefined) return settings.detected_models;
  // Older hosts only send saved choices. Use the bundled catalog until they
  // can report live detection, so newly supported models still appear.
  let catalog: DetectedAgentModels = {};
  for (let option of CURRENT_AGENT_MODEL_OPTIONS) {
    if (option.modelId) (catalog[option.provider] ??= []).push([option.modelId, option.label]);
  }
  return catalog;
};

export let resolveEnabledModels = (
  enabledModels: Record<string, string[]>,
  detectedModels: DetectedAgentModels = {},
  disabledModels: Record<string, string[]> = {},
): Record<string, string[]> => {
  let result = { ...enabledModels };
  for (let provider of new Set([...Object.keys(detectedModels), ...Object.keys(disabledModels)])) {
    let enabled = enabledModels[provider];
    // An explicit empty provider remains disabled, including future detections.
    if (enabled?.length === 0) continue;
    // OpenCode catalogs span many providers; keep their opt-in selection.
    if (provider === "opencode" && enabled === undefined) continue;
    let detected = provider === "opencode" ? [] : (detectedModels[provider] ?? []).map(([id]) => id);
    let fallback = CURRENT_AGENT_MODEL_OPTIONS
      .filter((option) => option.provider === provider)
      .flatMap((option) => option.modelId ? [option.modelId] : []);
    let excluded = new Set(disabledModels[provider] ?? []);
    result[provider] = [...new Set([...(enabled ?? (detected.length ? [] : fallback)), ...detected])]
      .filter((id) => !excluded.has(id) && !(provider === "antigravity" && excluded.has(geminiBaseModel(id))) && !isSyntheticAgentModel(id));
  }
  return result;
};

export let buildModelOptions = (
  availableProviders: ProcessProvider[],
  enabledModels: Record<string, string[]>,
  detectedModels: DetectedAgentModels = {},
  disabledModels: Record<string, string[]> = {},
): AgentModelOption[] => {
  let options: AgentModelOption[] = [];
  let enabled = resolveEnabledModels(enabledModels, detectedModels, disabledModels);
  let catalog: AgentModelOption[] = [
    ...(["codex", "claude", "opencode", "antigravity"] as ProcessProvider[]).flatMap((provider) =>
      (detectedModels[provider] ?? []).map(([modelId, label]) => ({ provider, modelId, label }))),
    ...CURRENT_AGENT_MODEL_OPTIONS,
  ];
  for (let provider of availableProviders) {
    let current = catalog.filter((option) => option.provider === provider);
    let selected = enabled[provider] === undefined
      ? (provider === "opencode" ? [] : current).flatMap((option) => option.modelId ? [option.modelId] : [])
      : enabled[provider];
    let modelIds = [...new Set(selected.filter((id) => !isSyntheticAgentModel(id)))];
    if (modelIds.length === 0 && enabled[provider] !== undefined && provider !== "shell") continue;
    if (modelIds.length === 0) {
      let bare = BARE_PROVIDER_OPTIONS.find((option) => option.provider === provider);
      options.push(bare ?? { provider, modelId: null, label: labelForProvider(provider) });
      continue;
    }
    for (let modelId of modelIds) {
      let known = current.find((option) => option.modelId === modelId);
      options.push({ provider, modelId, label: known?.label ?? labelForProviderModel(provider, modelId) });
    }
  }
  return options.sort(modelOrder);
};
