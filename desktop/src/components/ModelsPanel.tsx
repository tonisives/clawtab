import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { ProcessProvider } from "@clawtab/shared"
import type { AppSettings } from "../types"
import {
  BUILTIN_MODELS,
  labelForProvider,
  labelForProviderModel,
} from "./JobEditor/utils"

interface ModelEntry {
  provider: ProcessProvider
  modelId: string
  displayName: string
  builtin: boolean
  enabled: boolean
}

const PROVIDERS_WITH_MODELS: ProcessProvider[] = ["claude", "codex"]

function buildAllModels(
  enabledModels: Record<string, string[]>,
): ModelEntry[] {
  const entries: ModelEntry[] = []
  const enabledSets: Record<string, Set<string>> = {}
  for (const [provider, list] of Object.entries(enabledModels)) {
    enabledSets[provider] = new Set(list)
  }

  for (const opt of BUILTIN_MODELS) {
    if (!opt.modelId) continue
    entries.push({
      provider: opt.provider,
      modelId: opt.modelId,
      displayName: opt.label,
      builtin: true,
      enabled: enabledSets[opt.provider]?.has(opt.modelId) ?? false,
    })
  }

  // Custom models (in enabled_models but not in builtins)
  for (const provider of PROVIDERS_WITH_MODELS) {
    const custom = enabledModels[provider] ?? []
    for (const modelId of custom) {
      if (entries.some((e) => e.provider === provider && e.modelId === modelId)) continue
      entries.push({
        provider,
        modelId,
        displayName: labelForProviderModel(provider, modelId),
        builtin: false,
        enabled: true,
      })
    }
  }

  return entries
}

/** Group OpenCode model IDs by their provider prefix (e.g. "opencode", "amazon-bedrock", "zai") */
function groupOpencodeModels(
  models: string[],
  enabledSet: Set<string>,
): { namespace: string; models: { id: string; name: string; enabled: boolean }[] }[] {
  const groups = new Map<string, { id: string; name: string; enabled: boolean }[]>()
  for (const id of models) {
    const slashIdx = id.indexOf("/")
    const namespace = slashIdx >= 0 ? id.slice(0, slashIdx) : "other"
    const name = slashIdx >= 0 ? id.slice(slashIdx + 1) : id
    const list = groups.get(namespace) ?? []
    list.push({ id, name, enabled: enabledSet.has(id) })
    groups.set(namespace, list)
  }
  return Array.from(groups.entries()).map(([namespace, models]) => ({ namespace, models }))
}

export function ModelsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [customModelInput, setCustomModelInput] = useState<Record<string, string>>({})
  const [opencodeModels, setOpencodeModels] = useState<string[]>([])
  const [opencodeLoading, setOpencodeLoading] = useState(false)
  const [opencodeError, setOpencodeError] = useState<string | null>(null)
  const [expandedNamespaces, setExpandedNamespaces] = useState<Set<string>>(new Set())

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e))
  }, [])

  // Detect OpenCode models on mount
  useEffect(() => {
    setOpencodeLoading(true)
    invoke<string[]>("detect_opencode_models")
      .then((models) => {
        setOpencodeModels(models)
        setOpencodeError(null)
      })
      .catch((e) => {
        setOpencodeError(String(e))
        setOpencodeModels([])
      })
      .finally(() => setOpencodeLoading(false))
  }, [])

  const update = async (updates: Partial<AppSettings>) => {
    if (!settings) return
    const newSettings = { ...settings, ...updates }
    setSettings(newSettings)
    try {
      await invoke("set_settings", { newSettings })
    } catch (e) {
      console.error("Failed to save settings:", e)
    }
  }

  if (!settings) {
    return <div className="loading">Loading settings...</div>
  }

  const enabledModels = settings.enabled_models ?? {}
  const allModels = buildAllModels(enabledModels)
  const defaultProvider = settings.default_provider
  const defaultModel = settings.default_model ?? null

  const isDefault = (provider: ProcessProvider, modelId: string) =>
    provider === defaultProvider && modelId === defaultModel

  const setAsDefault = (provider: ProcessProvider, modelId: string) => {
    update({ default_provider: provider, default_model: modelId })
  }

  const clearDefault = () => {
    update({ default_model: null })
  }

  const toggleModel = (provider: string, modelId: string, on: boolean) => {
    const next = { ...enabledModels }
    const list = [...(next[provider] ?? [])]
    if (on) {
      if (!list.includes(modelId)) list.push(modelId)
    } else {
      const idx = list.indexOf(modelId)
      if (idx >= 0) list.splice(idx, 1)
    }
    if (list.length > 0) {
      next[provider] = list
    } else {
      delete next[provider]
    }
    // If disabling the current default model, clear it
    if (!on && isDefault(provider as ProcessProvider, modelId)) {
      update({ enabled_models: next, default_model: null })
    } else {
      update({ enabled_models: next })
    }
  }

  const removeCustomModel = (provider: ProcessProvider, modelId: string) => {
    const next = { ...enabledModels }
    const list = (next[provider] ?? []).filter((id) => id !== modelId)
    if (list.length > 0) {
      next[provider] = list
    } else {
      delete next[provider]
    }
    if (isDefault(provider, modelId)) {
      update({ enabled_models: next, default_model: null })
    } else {
      update({ enabled_models: next })
    }
  }

  const addCustomModel = (provider: ProcessProvider) => {
    const modelId = (customModelInput[provider] ?? "").trim()
    if (!modelId) return
    if (allModels.some((m) => m.provider === provider && m.modelId === modelId)) return
    const next = { ...enabledModels }
    next[provider] = [...(next[provider] ?? []), modelId]
    update({ enabled_models: next })
    setCustomModelInput((prev) => ({ ...prev, [provider]: "" }))
  }

  const toggleNamespace = (ns: string) => {
    setExpandedNamespaces((prev) => {
      const next = new Set(prev)
      if (next.has(ns)) next.delete(ns)
      else next.add(ns)
      return next
    })
  }

  const providerGroups = new Map<ProcessProvider, ModelEntry[]>()
  for (const entry of allModels) {
    if (entry.provider === "opencode") continue // OpenCode handled separately
    const list = providerGroups.get(entry.provider) ?? []
    list.push(entry)
    providerGroups.set(entry.provider, list)
  }

  const opencodeEnabledSet = new Set(enabledModels["opencode"] ?? [])
  const opencodeGroups = groupOpencodeModels(opencodeModels, opencodeEnabledSet)
  const opencodeEnabledCount = opencodeEnabledSet.size

  return (
    <div className="settings-section">
      <h2>Models</h2>
      <p className="section-description" style={{ marginTop: 0, marginBottom: 16 }}>
        Toggle which models appear in the agent dropdown. Set a default model
        or add custom model IDs.
      </p>

      {/* Default model display */}
      <div className="field-group">
        <span className="field-group-title">Default</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          {defaultModel ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
                {labelForProviderModel(defaultProvider, defaultModel)}
              </span>
              <button className="btn btn-sm" onClick={clearDefault}>
                Clear
              </button>
            </div>
          ) : (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {labelForProvider(defaultProvider)} (no specific model)
            </span>
          )}
          <span className="hint">
            The default model used when a job doesn't specify one.
          </span>
        </div>
      </div>

      {/* Model lists per provider (Claude, Codex) */}
      {Array.from(providerGroups.entries()).map(([provider, models]) => (
        <div className="field-group" key={provider}>
          <span className="field-group-title">{labelForProvider(provider)}</span>
          {models.map((entry) => (
            <div
              key={entry.modelId}
              className="form-group"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
                paddingTop: 2,
                paddingBottom: 2,
              }}
            >
              <label className="checkbox-label" style={{ flex: 1, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  onChange={(e) => toggleModel(entry.provider, entry.modelId, e.target.checked)}
                />
                <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
                  {entry.displayName}
                  {!entry.builtin && (
                    <span style={{ color: "var(--text-secondary)", fontSize: 11, marginLeft: 6 }}>
                      (custom)
                    </span>
                  )}
                </span>
              </label>
              {entry.enabled && isDefault(entry.provider, entry.modelId) ? (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--accent, #7986cb)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  default
                </span>
              ) : entry.enabled ? (
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: "1px 6px" }}
                  onClick={() => setAsDefault(entry.provider, entry.modelId)}
                >
                  Set default
                </button>
              ) : null}
              {!entry.builtin && (
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: "1px 6px" }}
                  onClick={() => removeCustomModel(entry.provider, entry.modelId)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          {/* Add custom model input */}
          {PROVIDERS_WITH_MODELS.includes(provider) && (
            <div
              className="form-group"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 4,
                marginBottom: 0,
              }}
            >
              <input
                type="text"
                placeholder="Custom model ID..."
                value={customModelInput[provider] ?? ""}
                onChange={(e) =>
                  setCustomModelInput((prev) => ({ ...prev, [provider]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") addCustomModel(provider)
                }}
                style={{ flex: 1, fontSize: 12 }}
              />
              <button
                className="btn btn-sm"
                onClick={() => addCustomModel(provider)}
                disabled={!(customModelInput[provider] ?? "").trim()}
              >
                Add
              </button>
            </div>
          )}
        </div>
      ))}

      {/* OpenCode models */}
      <div className="field-group">
        <span className="field-group-title">
          OpenCode
          {opencodeEnabledCount > 0 && (
            <span style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 400, marginLeft: 6 }}>
              ({opencodeEnabledCount} enabled)
            </span>
          )}
        </span>
        {opencodeLoading && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Detecting models...</span>
          </div>
        )}
        {opencodeError && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Could not detect models (is opencode installed?)
            </span>
          </div>
        )}
        {!opencodeLoading && !opencodeError && opencodeGroups.length === 0 && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>No models found</span>
          </div>
        )}
        {opencodeGroups.map(({ namespace, models }) => {
          const expanded = expandedNamespaces.has(namespace)
          const enabledInGroup = models.filter((m) => m.enabled).length
          return (
            <div key={namespace} style={{ marginBottom: 4 }}>
              <button
                onClick={() => toggleNamespace(namespace)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: "2px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  width: "100%",
                }}
              >
                <span style={{ fontSize: 10, color: "var(--text-muted)", width: 12, textAlign: "center" }}>
                  {expanded ? "\u25BC" : "\u25B6"}
                </span>
                <span style={{ fontWeight: 500 }}>{namespace}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  ({models.length}{enabledInGroup > 0 ? `, ${enabledInGroup} on` : ""})
                </span>
              </button>
              {expanded && (
                <div style={{ paddingLeft: 16 }}>
                  {models.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        paddingTop: 1,
                        paddingBottom: 1,
                      }}
                    >
                      <label className="checkbox-label" style={{ flex: 1, margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) => toggleModel("opencode", m.id, e.target.checked)}
                        />
                        <span style={{ fontSize: 12, color: "var(--text-primary)" }}>
                          {m.name}
                        </span>
                      </label>
                      {m.enabled && isDefault("opencode", m.id) ? (
                        <span style={{ fontSize: 11, color: "var(--accent, #7986cb)", fontWeight: 500 }}>
                          default
                        </span>
                      ) : m.enabled ? (
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 11, padding: "1px 6px" }}
                          onClick={() => setAsDefault("opencode", m.id)}
                        >
                          Set default
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div className="form-group" style={{ marginTop: 4, marginBottom: 0 }}>
          <span className="hint">
            OpenCode uses <code>-m provider/model</code> format. Toggle models to include them in the dropdown.
          </span>
        </div>
      </div>

      {/* Shell note */}
      <div className="field-group">
        <span className="field-group-title">Shell</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <span className="hint">
            Shell doesn't support model selection.
          </span>
        </div>
      </div>
    </div>
  )
}
