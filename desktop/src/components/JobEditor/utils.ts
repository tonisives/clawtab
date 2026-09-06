import { CURRENT_AGENT_MODEL_OPTIONS, isSyntheticAgentModel } from "@clawtab/shared";
import type { CalendarSchedule, ProcessProvider } from "@clawtab/shared";
import { DAYS, CRON_DAY_MAP, DAY_CRON_MAP, JOB_NAME_MAX_LENGTH } from "./types";

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;

export function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, JOB_NAME_MAX_LENGTH);
}

export function labelForProvider(provider: ProcessProvider): string {
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
      return "Shell";
  }
}

export interface ModelOption {
  provider: ProcessProvider;
  modelId: string | null;
  label: string;
}

/** Bare provider entries used as fallback when a provider has no enabled models. */
export const BARE_PROVIDER_OPTIONS: ModelOption[] = [
  { provider: "claude", modelId: null, label: "Claude Code" },
  { provider: "codex", modelId: null, label: "Codex" },
  { provider: "opencode", modelId: null, label: "OpenCode" },
  { provider: "antigravity", modelId: null, label: "Antigravity" },
  { provider: "shell", modelId: null, label: "Shell" },
];

export function labelForProviderModel(provider: ProcessProvider, model: string | null | undefined): string {
  if (!model) return labelForProvider(provider);
  return `${labelForProvider(provider)} (${model})`;
}

/** Encode provider + model as a compound select value */
export function encodeProviderModel(provider: ProcessProvider, model: string | null): string {
  return model ? `${provider}:${model}` : `${provider}:`;
}

/** Decode a compound select value back to provider + model */
export function decodeProviderModel(value: string): { provider: ProcessProvider; model: string | null } {
  const idx = value.indexOf(":");
  if (idx === -1) return { provider: value as ProcessProvider, model: null };
  const provider = value.slice(0, idx) as ProcessProvider;
  const model = value.slice(idx + 1) || null;
  return { provider, model };
}

/** Build the list of model options for a dropdown, respecting the enabled model selection.
 * Providers without any known model get a bare fallback entry (no specific model). */
export function buildModelOptions(
  availableProviders: ProcessProvider[],
  enabledModels: Record<string, string[]>,
): ModelOption[] {
  const options: ModelOption[] = [];
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

function parseSingleCronToWeekly(cron: string): { days: string[]; time: string } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*") return null;
  if (hour === "*" || min === "*") return null;
  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m)) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dow === "*") {
    return { days: [...DAYS], time };
  }
  const dayNums = dow.split(",");
  const dayNames = dayNums.map((d) => CRON_DAY_MAP[d.trim()]).filter(Boolean);
  if (dayNames.length === 0) return null;
  return { days: dayNames, time };
}

export function parseCronToWeekly(cron: string): { days: string[]; times: string[] } | null {
  const cronParts = cron.split("|").map((s) => s.trim()).filter(Boolean);
  if (cronParts.length === 0) return null;
  const parsed = cronParts.map(parseSingleCronToWeekly);
  if (parsed.some((p) => p === null)) return null;
  const valid = parsed as { days: string[]; time: string }[];
  const firstDays = valid[0].days.sort().join(",");
  if (!valid.every((p) => p.days.sort().join(",") === firstDays)) return null;
  return {
    days: valid[0].days,
    times: valid.map((p) => p.time),
  };
}

export function buildWeeklyCron(days: string[], times: string[]): string {
  if (days.length === 0 || times.length === 0) return "0 0 * * *";
  const dowList = days.map((d) => DAY_CRON_MAP[d]).join(",");
  const crons = times.map((time) => {
    const [h, m] = time.split(":").map(Number);
    return `${m ?? 0} ${h ?? 0} * * ${dowList}`;
  });
  return crons.join(" | ");
}

export function buildCalendarSchedule(start: string, every: number): CalendarSchedule {
  return {
    start,
    repeat: {
      every: Math.max(1, Math.floor(every)),
      unit: "week",
    },
  };
}

export function defaultCalendarStart(now: Date = new Date()): string {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const day = String(start.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}T09:00`;
}
