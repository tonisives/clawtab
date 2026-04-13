import type { ProcessProvider } from "@clawtab/shared";
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
    case "shell":
      return "Shell";
  }
}

export interface ModelOption {
  provider: ProcessProvider;
  modelId: string | null;
  label: string;
}

export const BUILTIN_MODELS: ModelOption[] = [
  { provider: "claude", modelId: "claude-opus-4-6", label: "Claude Code (Opus 4.6)" },
  { provider: "claude", modelId: "claude-sonnet-4-6", label: "Claude Code (Sonnet 4.6)" },
  { provider: "claude", modelId: "claude-haiku-4-5", label: "Claude Code (Haiku 4.5)" },
  { provider: "codex", modelId: "gpt-5.4", label: "Codex (GPT-5.4)" },
  { provider: "codex", modelId: "gpt-5.4-mini", label: "Codex (GPT-5.4 Mini)" },
  { provider: "codex", modelId: "gpt-5.3-codex", label: "Codex (GPT-5.3 Codex)" },
  { provider: "codex", modelId: "o3", label: "Codex (o3)" },
  { provider: "codex", modelId: "o4-mini", label: "Codex (o4-mini)" },
  { provider: "opencode", modelId: null, label: "OpenCode" },
  { provider: "shell", modelId: null, label: "Shell" },
];

const MODEL_DISPLAY_NAMES: Record<string, string> = {
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

/** Seed enabled_models with builtin defaults when empty (first launch / upgrade) */
export function seedEnabledModels(): Record<string, string[]> {
  const seeded: Record<string, string[]> = {};
  for (const opt of BUILTIN_MODELS) {
    if (!opt.modelId) continue;
    const list = seeded[opt.provider] ?? [];
    list.push(opt.modelId);
    seeded[opt.provider] = list;
  }
  return seeded;
}

/** Build the list of model options for a dropdown, given available providers and user-enabled models.
 *  Only models present in enabledModels are shown. Providers without any enabled models
 *  get a bare fallback entry (no specific model). */
export function buildModelOptions(
  availableProviders: ProcessProvider[],
  enabledModels: Record<string, string[]>,
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of availableProviders) {
    const enabled = enabledModels[provider] ?? [];
    if (enabled.length === 0) {
      // Bare provider fallback (no specific model)
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
