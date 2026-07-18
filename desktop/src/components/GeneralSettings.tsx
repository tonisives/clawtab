import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import type { ProcessProvider } from "@clawtab/shared"
import type { AppSettings } from "../types"
import { ToolsPanel } from "./ToolsPanel"
import { TelegramPanel } from "./TelegramPanel"
import { RelayPanel } from "./RelayPanel"
import { ShortcutsPanel } from "./ShortcutsPanel"
import { ModelsPanel } from "./ModelsPanel"
import { DaemonPanel } from "./DaemonPanel"

export type SettingsSubTab = "general" | "remote" | "telegram" | "shortcuts" | "models" | "daemon"
const settingsSubTabIds: SettingsSubTab[] = ["general", "remote", "telegram", "shortcuts", "models", "daemon"]
const SETTINGS_SUBTAB_KEY = "desktop_settings_subtab"
const SETTINGS_SUBTAB_SCROLL_PREFIX = "desktop_settings_subtab_scroll"

interface Props {
  activeSubTab: SettingsSubTab
  onSubTabChange: (tab: SettingsSubTab) => void
  externalAccessToken: string | null
  externalRefreshToken: string | null
  onExternalTokenConsumed: () => void
  daemonAlert?: boolean
}

const subTabs: { id: SettingsSubTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "remote", label: "Remote" },
  { id: "telegram", label: "Telegram" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "models", label: "Models" },
  { id: "daemon", label: "Daemon" },
]

type AgentIntegrationStatus = {
  provider: ProcessProvider
  detected: boolean
  configured: boolean
  active: boolean
  needs_repair: boolean
  needs_restart: boolean
  capabilities: string[]
  detail: string
}

const integrationLabel = (provider: ProcessProvider): string => {
  if (provider === "opencode") return "OpenCode"
  if (provider === "antigravity") return "Antigravity"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function readStoredSettingsSubTab(): SettingsSubTab {
  if (typeof localStorage === "undefined") return "general"
  try {
    const value = localStorage.getItem(SETTINGS_SUBTAB_KEY)
    return settingsSubTabIds.includes(value as SettingsSubTab) ? (value as SettingsSubTab) : "general"
  } catch {
    return "general"
  }
}

export function GeneralSettings({
  activeSubTab,
  onSubTabChange,
  externalAccessToken,
  externalRefreshToken,
  onExternalTokenConsumed,
  daemonAlert,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_SUBTAB_KEY, activeSubTab)
    } catch {
      // Keep settings usable if storage is unavailable.
    }
  }, [activeSubTab])

  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    let y = 0
    try {
      const raw = localStorage.getItem(`${SETTINGS_SUBTAB_SCROLL_PREFIX}_${activeSubTab}`)
      y = raw ? Number(raw) : 0
    } catch {
      y = 0
    }
    if (!Number.isFinite(y)) return
    const restore = () => {
      node.scrollTop = y
    }
    const frame = requestAnimationFrame(restore)
    const timer = window.setTimeout(restore, 100)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [activeSubTab])

  const handleContentScroll = () => {
    const node = contentRef.current
    if (!node) return
    try {
      localStorage.setItem(`${SETTINGS_SUBTAB_SCROLL_PREFIX}_${activeSubTab}`, String(node.scrollTop))
    } catch {
      // Ignore persistence failures; scrolling should remain unaffected.
    }
  }

  return (
    <div className="settings-with-subtabs">
      <div className="settings-subtab-bar">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            className={`settings-subtab ${activeSubTab === tab.id ? "active" : ""}`}
            onClick={() => onSubTabChange(tab.id)}
            title={tab.id === "daemon" && daemonAlert ? "Daemon is not running" : undefined}
          >
            {tab.label}
            {tab.id === "daemon" && daemonAlert && <span className="subtab-alert-dot" />}
          </button>
        ))}
      </div>
      <div ref={contentRef} className="settings-subtab-content" onScroll={handleContentScroll}>
        {activeSubTab === "general" && <GeneralSettingsContent />}
        {activeSubTab === "remote" && (
          <RelayPanel
            externalAccessToken={externalAccessToken}
            externalRefreshToken={externalRefreshToken}
            onExternalTokenConsumed={onExternalTokenConsumed}
          />
        )}
        {activeSubTab === "telegram" && <TelegramPanel />}
        {activeSubTab === "shortcuts" && <ShortcutsPanel />}
        {activeSubTab === "models" && <ModelsPanel />}
        {activeSubTab === "daemon" && <DaemonPanel />}
      </div>
    </div>
  )
}

function GeneralSettingsContent() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [showToolsModal, setShowToolsModal] = useState(false)
  const toolsOverlayRef = useRef<HTMLDivElement>(null)
  const [version, setVersion] = useState<string>("")
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "up-to-date" | "installed" | "error"
  >("idle")
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [agentIntegrations, setAgentIntegrations] = useState<AgentIntegrationStatus[]>([])
  const [integrationBusy, setIntegrationBusy] = useState<ProcessProvider | null>(null)
  const [integrationError, setIntegrationError] = useState<string | null>(null)

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e))
    invoke<string>("get_version").then(setVersion)
    invoke<AgentIntegrationStatus[]>("get_agent_integrations")
      .then(setAgentIntegrations)
      .catch((e) => setIntegrationError(String(e)))
  }, [])

  const changeAgentIntegration = async (
    provider: ProcessProvider,
    action: "install_agent_integration" | "remove_agent_integration",
  ) => {
    setIntegrationBusy(provider)
    setIntegrationError(null)
    try {
      const statuses = await invoke<AgentIntegrationStatus[]>(action, { provider })
      setAgentIntegrations(statuses)
    } catch (error) {
      setIntegrationError(String(error))
    } finally {
      setIntegrationBusy(null)
    }
  }

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

  const toggleTitlebar = async (hidden: boolean) => {
    await update({ hide_titlebar: hidden })
    try {
      await invoke("set_titlebar_visibility", { hidden })
    } catch (e) {
      console.error("Failed to set titlebar visibility:", e)
    }
  }

  const checkForUpdate = async () => {
    setUpdateStatus("checking")
    try {
      const result = await invoke<string | null>("check_for_update")
      setLastChecked(new Date())
      if (result) {
        setUpdateVersion(result)
        setUpdateStatus("installed")
      } else {
        setUpdateStatus("up-to-date")
      }
    } catch (e) {
      console.error("Update check failed:", e)
      setUpdateStatus("error")
    }
  }

  const formatLastChecked = (date: Date): string => {
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

  if (!settings) {
    return <div className="loading">Loading settings...</div>
  }

  return (
    <div className="settings-section">
      <h2>General Settings</h2>

      <div className="field-group">
        <span className="field-group-title">Appearance</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.hide_titlebar}
              onChange={(e) => toggleTitlebar(e.target.checked)}
            />
            Hide Title Bar
          </label>
          <span className="hint">Uses overlay style with native traffic light buttons</span>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Behavior</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.auto_release_on_blur}
              onChange={(e) => update({ auto_release_on_blur: e.target.checked })}
            />
            Release captured panes when ClawTab loses focus
          </label>
          <span className="hint">
            Returns panes to their original tmux windows on blur, re-captures on focus. 3 second debounce.
          </span>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Notifications</span>
        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.notify_questions_local}
              onChange={(e) => update({ notify_questions_local: e.target.checked })}
            />
            Desktop question notifications
          </label>
          <span className="hint">Show local macOS notifications when an agent asks a question</span>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.notify_questions_remote}
              onChange={(e) => update({ notify_questions_remote: e.target.checked })}
            />
            Remote question notifications
          </label>
          <span className="hint">Send question notifications to connected remote clients</span>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Agent integrations</span>
        <p className="section-description agent-integration-description">
          Hooks provide immediate activity and permission signals. ClawTab keeps terminal detection as a fallback.
        </p>
        <div className="agent-integration-list">
          {agentIntegrations.map((integration) => (
            <div className="agent-integration-row" key={integration.provider}>
              <div className="agent-integration-main">
                <div className="agent-integration-heading">
                  <strong>{integrationLabel(integration.provider)}</strong>
                  <span className={`agent-integration-status ${integration.active ? "active" : integration.configured ? "configured" : "available"}`}>
                    {integration.active ? "Active" : integration.configured ? "Configured" : integration.detected ? "Available" : "Not detected"}
                  </span>
                </div>
                <span className="hint">{integration.detail}</span>
                <span className="agent-integration-capabilities">
                  {integration.capabilities.join(" · ")}
                </span>
              </div>
              <div className="btn-group">
                {integration.configured ? (
                  <>
                    <button
                      className="btn btn-sm"
                      disabled={integrationBusy !== null}
                      onClick={() => changeAgentIntegration(integration.provider, "install_agent_integration")}
                    >
                      {integrationBusy === integration.provider ? "Working..." : "Repair"}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={integrationBusy !== null}
                      onClick={() => changeAgentIntegration(integration.provider, "remove_agent_integration")}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={integrationBusy !== null || !integration.detected}
                    onClick={() => changeAgentIntegration(integration.provider, "install_agent_integration")}
                  >
                    {integrationBusy === integration.provider ? "Installing..." : "Install"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {integrationError && <span className="agent-integration-error">{integrationError}</span>}
        <span className="hint">
          Restart running agent sessions after setup. Codex also requires approving the installed commands in /hooks.
        </span>
      </div>

      <div className="field-group">
        <span className="field-group-title">About</span>
        <div className="form-group">
          <label>Version</label>
          <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{version || "..."}</span>
        </div>
        <div className="form-group">
          <label>Updates</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn" disabled={updateStatus === "checking"} onClick={checkForUpdate}>
              {updateStatus === "checking" ? "Checking..." : "Check for updates"}
            </button>
            {updateStatus === "up-to-date" && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Up to date</span>
            )}
            {updateStatus === "installed" && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                v{updateVersion} installed -{" "}
                <button
                  className="btn btn-sm"
                  onClick={() => invoke("restart_app")}
                  style={{ display: "inline", padding: "2px 8px", fontSize: 11 }}
                >
                  Restart
                </button>
              </span>
            )}
            {updateStatus === "error" && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Check failed</span>
            )}
          </div>
          {lastChecked && (
            <span className="hint">Last checked: {formatLastChecked(lastChecked)}</span>
          )}
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.auto_update_enabled}
              onChange={(e) => update({ auto_update_enabled: e.target.checked })}
            />
            Automatically check for updates
          </label>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Paths</span>
        <div className="form-group">
          <label>Claude CLI Path</label>
          <input
            type="text"
            value={settings.claude_path}
            onChange={(e) => update({ claude_path: e.target.value })}
            placeholder="claude"
          />
          <span className="hint">Path to claude CLI binary</span>
        </div>

        <div className="form-group">
          <label>Default Working Directory</label>
          <input
            type="text"
            value={settings.default_work_dir}
            onChange={(e) => update({ default_work_dir: e.target.value })}
            placeholder="~/workspace/tgs/automation"
            style={{ maxWidth: "100%" }}
          />
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Runtime</span>
        <div className="form-group">
          <label>Default Tmux Session</label>
          <input
            type="text"
            value={settings.default_tmux_session}
            onChange={(e) => update({ default_tmux_session: e.target.value })}
            placeholder="tgs"
          />
          <span className="hint">Tmux session name for Claude jobs</span>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Maintenance</span>
        <div className="form-group">
          <p className="section-description" style={{ marginTop: 0, marginBottom: 8 }}>
            Re-run the initial setup wizard to detect tools and configure defaults.
          </p>
          <button
            className="btn"
            onClick={() => {
              const base = window.location.origin
              new WebviewWindow("setup-wizard", {
                url: `${base}/settings.html?setup`,
                title: "ClawTab Setup",
                width: 640,
                height: 520,
                center: true,
              })
            }}
          >
            Run Setup Wizard
          </button>
        </div>
        <div className="form-group">
          <label>Tools</label>
          <div>
            <button className="btn" onClick={() => setShowToolsModal(true)}>
              Manage Tools
            </button>
            <span className="hint">Detect and configure CLI tools</span>
          </div>
        </div>
        <div className="form-group">
          <label>Logs</label>
          <div>
            <button className="btn" onClick={() => invoke("open_logs_folder")}>
              Open Logs Folder
            </button>
            <span className="hint">/tmp/clawtab/</span>
          </div>
        </div>
      </div>

      {showToolsModal && (
        <div
          ref={toolsOverlayRef}
          className="tools-modal-overlay"
          onClick={(e) => {
            if (e.target === toolsOverlayRef.current) setShowToolsModal(false)
          }}
        >
          <div className="tools-modal">
            <div className="tools-modal-header">
              <h3>Tools</h3>
              <button className="btn btn-sm" onClick={() => setShowToolsModal(false)}>
                Close
              </button>
            </div>
            <ToolsPanel />
          </div>
        </div>
      )}
    </div>
  )
}
