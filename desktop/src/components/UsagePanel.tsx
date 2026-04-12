import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { AppSettings, ProviderUsageSnapshot, SecretEntry, UsageSnapshot } from "../types"

export function UsagePanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [secretKeys, setSecretKeys] = useState<string[]>([])
  const [zaiApiKey, setZaiApiKey] = useState("")
  const [zaiKeySaving, setZaiKeySaving] = useState(false)
  const [zaiKeyMessage, setZaiKeyMessage] = useState<string | null>(null)

  const hasStoredZaiKey = secretKeys.includes("Z_AI_API_KEY")

  useEffect(() => {
    void loadSettings()
    void loadSecretKeys()
    void refreshUsage()
  }, [])

  const loadSettings = async () => {
    try {
      const nextSettings = await invoke<AppSettings>("get_settings")
      setSettings(nextSettings)
    } catch (e) {
      console.error("Failed to load settings:", e)
    }
  }

  const loadSecretKeys = async () => {
    try {
      const secrets = await invoke<SecretEntry[]>("list_secrets")
      setSecretKeys(secrets.map((secret) => secret.key))
    } catch (e) {
      console.error("Failed to load secrets:", e)
    }
  }

  const refreshUsage = async () => {
    setUsageLoading(true)
    setUsageError(null)
    try {
      const nextUsage = await invoke<UsageSnapshot>("get_usage_snapshot")
      setUsage(nextUsage)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setUsageError(message)
    } finally {
      setUsageLoading(false)
    }
  }

  const saveSettings = async (updates: Partial<AppSettings>) => {
    if (!settings) return
    const nextSettings = { ...settings, ...updates }
    setSettings(nextSettings)
    try {
      await invoke("set_settings", { newSettings: nextSettings })
    } catch (e) {
      console.error("Failed to save settings:", e)
    }
  }

  const toggleTrayIcon = async (visible: boolean) => {
    await saveSettings({ show_tray_icon: visible })
    try {
      await invoke("set_tray_icon_visibility", { visible })
    } catch (e) {
      console.error("Failed to set tray icon visibility:", e)
    }
  }

  const saveZaiApiKey = async () => {
    const value = zaiApiKey.trim()
    if (!value) {
      setZaiKeyMessage("Paste a z.ai API key before saving.")
      return
    }

    setZaiKeySaving(true)
    setZaiKeyMessage(null)
    try {
      await invoke("set_secret", { key: "Z_AI_API_KEY", value })
      setZaiApiKey("")
      await loadSecretKeys()
      await refreshUsage()
      setZaiKeyMessage("z.ai API key saved.")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setZaiKeyMessage(`Failed to save z.ai API key: ${message}`)
    } finally {
      setZaiKeySaving(false)
    }
  }

  const removeZaiApiKey = async () => {
    setZaiKeySaving(true)
    setZaiKeyMessage(null)
    try {
      await invoke("delete_secret", { key: "Z_AI_API_KEY" })
      await loadSecretKeys()
      await refreshUsage()
      setZaiKeyMessage("Stored z.ai API key removed.")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setZaiKeyMessage(`Failed to remove z.ai API key: ${message}`)
    } finally {
      setZaiKeySaving(false)
    }
  }

  return (
    <div className="settings-section">
      <h2>Usage</h2>

      <div className="field-group">
        <span className="field-group-title">Providers</span>
        <p className="section-description usage-description">
          Claude and Codex use local CLI quota windows. z.ai uses a stored API key or environment
          token.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <button className="btn" disabled={usageLoading} onClick={() => void refreshUsage()}>
            {usageLoading ? "Refreshing..." : "Refresh usage"}
          </button>
          {usage?.refreshed_at && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Updated {formatLastChecked(new Date(usage.refreshed_at))}
            </span>
          )}
        </div>
        {usageError && <span className="hint">Failed to load usage: {usageError}</span>}
        <div className="usage-grid">
          {usage ? (
            <>
              <UsageCard title="Claude" usage={usage.claude} />
              <UsageCard title="Codex" usage={usage.codex} />
              <div>
                <UsageCard title="z.ai" usage={usage.zai} />
                <div className="form-group usage-credential-group">
                  <label>z.ai API Key</label>
                  <div className="usage-credential-row">
                    <input
                      type="password"
                      value={zaiApiKey}
                      onChange={(e) => {
                        setZaiApiKey(e.target.value)
                        setZaiKeyMessage(null)
                      }}
                      placeholder={hasStoredZaiKey ? "Stored in Keychain" : "z.ai API key"}
                      autoComplete="off"
                    />
                    <button
                      className="btn btn-primary"
                      disabled={zaiKeySaving || !zaiApiKey.trim()}
                      onClick={() => void saveZaiApiKey()}
                    >
                      {hasStoredZaiKey ? "Update Key" : "Save Key"}
                    </button>
                    {hasStoredZaiKey && (
                      <button
                        className="btn"
                        disabled={zaiKeySaving}
                        onClick={() => void removeZaiApiKey()}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <span className="hint">
                    Saved as <code>Z_AI_API_KEY</code> in Keychain. ClawTab also checks{" "}
                    <code>ZAI_API_KEY</code>, <code>Z_AI_TOKEN</code>, and <code>ZAI_TOKEN</code>.
                  </span>
                  {zaiKeyMessage && <span className="hint">{zaiKeyMessage}</span>}
                </div>
              </div>
            </>
          ) : (
            <div className="usage-card">
              <div className="usage-card-header">
                <strong>Loading usage data...</strong>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Tray</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings?.show_tray_icon ?? true}
              disabled={!settings}
              onChange={(e) => void toggleTrayIcon(e.target.checked)}
            />
            Show tray icon
          </label>
          <span className="hint">Usage refreshes update the tray menu from this same snapshot.</span>
        </div>
      </div>
    </div>
  )
}

function UsageCard({ title, usage }: { title: string; usage: ProviderUsageSnapshot }) {
  return (
    <div className="usage-card">
      <div className="usage-card-header">
        <strong>{title}</strong>
        <span className={`usage-badge usage-${usage.status}`}>{usage.status}</span>
      </div>
      <div className="usage-summary">{usage.summary}</div>
      {usage.entries.length > 0 && (
        <div className="usage-list">
          {usage.entries.map((entry) => (
            <div className="usage-row" key={`${title}-${entry.label}`}>
              <span>{entry.label}</span>
              <strong>{entry.value}</strong>
            </div>
          ))}
        </div>
      )}
      {usage.note && <div className="usage-note">{usage.note}</div>}
    </div>
  )
}

function formatLastChecked(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  return `${diffHr}h ago`
}
