import { isSyntheticAgentModel } from "../types/process";
import type { ProcessProvider, AgentModelOption, AgentEffort } from "../types/process";
import { publishedModelOptions, recommendedModelIds } from "./modelCatalog";

export let geminiModelEffort = (id: string | null | undefined): AgentEffort | null => {
  if (!id || !/^gemini[-\s]/i.test(id)) return null;
  return (id.match(/(?:-(low|medium|high|xhigh|max)|\s+\((low|medium|high|xhigh|max)\))$/i)?.slice(1).find(Boolean)?.toLowerCase() as AgentEffort) ?? null;
};

export let geminiBaseModel = (id: string): string => geminiModelEffort(id)
  ? id.replace(/(?:-(?:low|medium|high|xhigh|max)|\s+\((?:low|medium|high|xhigh|max)\))$/i, "")
  : id;

let modelOrder = (left: AgentModelOption, right: AgentModelOption): number => {
  let providers = ["codex", "claude", "opencode", "antigravity", "hermes", "shell"];
  let providerRank = providers.indexOf(left.provider) - providers.indexOf(right.provider);
  if (providerRank) return providerRank;
  let rank = (option: AgentModelOption) => recommendedModelIds(option.provider).indexOf(option.modelId ?? "");
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
    case "hermes": return "Hermes";
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
  { provider: "hermes", modelId: null, label: "Hermes" },
];

export type DetectedAgentModels = Record<string, [string, string][]>;

export let hostModelCatalog = (settings?: { detected_models?: DetectedAgentModels } | null): DetectedAgentModels => {
  let catalog: DetectedAgentModels = {};
  for (let option of publishedModelOptions()) {
    if (option.provider === "hermes") continue;
    if (option.modelId) (catalog[option.provider] ??= []).push([option.modelId, option.label]);
  }
  for (let [provider, models] of Object.entries(settings?.detected_models ?? {})) {
    catalog[provider] = [...new Map([...(catalog[provider] ?? []), ...models]).entries()];
  }
  return catalog;
};

export let resolveEnabledModels = (
  enabledModels: Record<string, string[]>,
  detectedModels: DetectedAgentModels = {},
  disabledModels: Record<string, string[]> = {},
): Record<string, string[]> => {
  let result = { ...enabledModels };
  for (let provider of new Set([...Object.keys(enabledModels), ...Object.keys(detectedModels), ...Object.keys(disabledModels), ...publishedModelOptions().map((model) => model.provider)])) {
    let enabled = enabledModels[provider];
    // An explicit empty provider remains disabled, including future detections.
    if (enabled?.length === 0) continue;
    let defaults = recommendedModelIds(provider);
    // Hermes follows its configured inference provider. Other CLI discoveries
    // remain selectable in settings without flooding the launch menu.
    if (!defaults.length && provider !== "hermes") defaults = (detectedModels[provider] ?? []).map(([id]) => id).slice(0, 3);
    if (provider === "hermes") defaults = (detectedModels.hermes ?? []).map(([id]) => id).slice(0, 1);
    if (provider === "antigravity" && enabled === undefined) {
      let bases = new Set(defaults.map(geminiBaseModel));
      let variants = [...(detectedModels.antigravity ?? []).map(([id]) => id), ...publishedModelOptions().filter((model) => model.provider === provider).flatMap((model) => model.modelId ? [model.modelId] : [])];
      defaults = [...defaults, ...variants.filter((id) => geminiModelEffort(id) && bases.has(geminiBaseModel(id)))];
    }
    let excluded = new Set(disabledModels[provider] ?? []);
    if (enabled === undefined && defaults.length === 0) continue;
    result[provider] = [...new Set(enabled ?? defaults)]
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
    ...(["codex", "claude", "opencode", "antigravity", "hermes"] as ProcessProvider[]).flatMap((provider) =>
      (detectedModels[provider] ?? []).map(([modelId, label]) => ({ provider, modelId, label }))),
    ...publishedModelOptions(),
  ];
  for (let provider of availableProviders) {
    // Older hosts cannot launch Hermes. Show it once the host detects it or
    // the user has explicitly configured a Hermes model.
    if (provider === "hermes" && enabledModels.hermes === undefined && detectedModels.hermes === undefined) continue;
    let current = catalog.filter((option) => option.provider === provider);
    let selected = enabled[provider] === undefined
      ? recommendedModelIds(provider)
      : enabled[provider];
    let modelIds = [...new Set(selected.filter((id) => !isSyntheticAgentModel(id)))];
    const detectedHermesDefault = provider === "hermes" && enabledModels.hermes === undefined && detectedModels.hermes !== undefined;
    if (modelIds.length === 0 && enabled[provider] !== undefined && provider !== "shell" && !detectedHermesDefault) continue;
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
