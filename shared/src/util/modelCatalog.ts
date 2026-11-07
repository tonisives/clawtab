import { CURRENT_AGENT_MODEL_OPTIONS, type AgentModelOption, type ProcessProvider } from "../types/process";

export type PublishedModelCatalog = {
  version: 1;
  updated_at: string;
  providers: Record<string, { models: [string, string][]; recommended: string[]; updated_at: string }>;
};

export const MODEL_CATALOG_URL = "https://clawtab.cc/model-catalog.json";
const CACHE_KEY = "clawtab:model-catalog:v1";
let catalog: PublishedModelCatalog | null = null;
let listeners = new Set<() => void>();
let pending: Promise<void> | null = null;
let checkedAt = 0;
let optionsCache: AgentModelOption[] | null = null;

export function validateModelCatalog(value: unknown): value is PublishedModelCatalog {
  let data = value as PublishedModelCatalog;
  if (data?.version !== 1 || !Number.isFinite(Date.parse(data.updated_at)) || !data.providers) return false;
  let validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id);
  return ["codex", "claude", "opencode", "antigravity", "hermes"].every((provider) => {
    let entry = data.providers[provider];
    if (!entry || !Array.isArray(entry.models) || !entry.models.length || entry.models.length > 12000 || !Array.isArray(entry.recommended)) return false;
    if (!entry.models.every((pair) => Array.isArray(pair) && validId(pair[0]) && validId(pair[1]))) return false;
    let ids = new Set(entry.models.map(([id]) => id));
    return entry.recommended.length <= 3 && entry.recommended.every((id) => ids.has(id));
  });
}

export function installModelCatalog(value: unknown): boolean {
  if (!validateModelCatalog(value)) return false;
  if (catalog && Date.parse(value.updated_at) < Date.parse(catalog.updated_at)) return false;
  catalog = value;
  optionsCache = null;
  for (let listener of listeners) listener();
  return true;
}

export let getModelCatalog = () => catalog;
export let subscribeModelCatalog = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export async function refreshModelCatalog(force = false): Promise<void> {
  if (pending) return pending;
  if (!force && Date.now() - checkedAt < 6 * 60 * 60 * 1000) return;
  pending = (async () => {
    if (!catalog) {
      try {
        let saved = globalThis.localStorage?.getItem(CACHE_KEY);
        if (saved) installModelCatalog(JSON.parse(saved));
      } catch { /* Storage is optional on native and private browser sessions. */ }
    }
    let controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), 10000);
    try {
      let response = await fetch(MODEL_CATALOG_URL, { signal: controller.signal });
      if (!response.ok) throw new Error("Model catalog unavailable");
      let value: unknown = await response.json();
      if (!installModelCatalog(value)) throw new Error("Invalid model catalog");
      checkedAt = Date.now();
      try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* Optional cache. */ }
    } catch {
      // Keep the last valid catalog and retry on the next foreground refresh.
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => { pending = null; });
  return pending;
}

export function publishedModelOptions(): AgentModelOption[] {
  if (optionsCache) return optionsCache;
  let options = new Map<string, AgentModelOption>();
  for (let option of CURRENT_AGENT_MODEL_OPTIONS) {
    if (!catalog?.providers[option.provider]) options.set(`${option.provider}:${option.modelId}`, option);
  }
  for (let [provider, entry] of Object.entries(catalog?.providers ?? {})) {
    if (!["codex", "claude", "opencode", "antigravity", "hermes"].includes(provider)) continue;
    for (let [modelId, label] of entry.models) options.set(`${provider}:${modelId}`, { provider: provider as ProcessProvider, modelId, label });
  }
  optionsCache = [...options.values()];
  return optionsCache;
}

export function recommendedModelIds(provider: string): string[] {
  let published = catalog?.providers[provider]?.recommended;
  if (published) return published;
  if (provider === "codex") return ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"];
  if (provider === "claude") return ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"];
  return [];
}
