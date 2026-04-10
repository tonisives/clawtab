import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, ProviderUsageSnapshot, UsageSnapshot } from "../types";
import { ToolsPanel } from "./ToolsPanel";
import { TelegramPanel } from "./TelegramPanel";
import { RelayPanel } from "./RelayPanel";
import { ShortcutsPanel } from "./ShortcutsPanel";

export type SettingsSubTab = "general" | "remote" | "telegram" | "shortcuts";

interface Props {
  activeSubTab: SettingsSubTab;
  onSubTabChange: (tab: SettingsSubTab) => void;
  externalAccessToken: string | null;
  externalRefreshToken: string | null;
  onExternalTokenConsumed: () => void;
}

const subTabs: { id: SettingsSubTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "remote", label: "Remote" },
  { id: "telegram", label: "Telegram" },
  { id: "shortcuts", label: "Shortcuts" },
];

export function GeneralSettings({
  activeSubTab,
  onSubTabChange,
  externalAccessToken,
  externalRefreshToken,
  onExternalTokenConsumed,
}: Props) {
  return (
    <div className="settings-with-subtabs">
      <div className="settings-subtab-bar">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            className={`settings-subtab ${activeSubTab === tab.id ? "active" : ""}`}
            onClick={() => onSubTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="settings-subtab-content">
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
      </div>
    </div>
  );
}

function GeneralSettingsContent() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showToolsModal, setShowToolsModal] = useState(false);
  const toolsOverlayRef = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "up-to-date" | "installed" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
    invoke<string>("get_version").then(setVersion);
    void refreshUsage();
  }, []);

  const refreshUsage = async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const nextUsage = await invoke<UsageSnapshot>("get_usage_snapshot");
      setUsage(nextUsage);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setUsageError(message);
    } finally {
      setUsageLoading(false);
    }
  };

  const update = async (updates: Partial<AppSettings>) => {
    if (!settings) return;
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    try {
      await invoke("set_settings", { newSettings });
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  const toggleDock = async (visible: boolean) => {
    await update({ show_in_dock: visible });
    try {
      await invoke("set_dock_visibility", { visible });
    } catch (e) {
      console.error("Failed to set dock visibility:", e);
    }
  };

  const toggleTitlebar = async (hidden: boolean) => {
    await update({ hide_titlebar: hidden });
    try {
      await invoke("set_titlebar_visibility", { hidden });
    } catch (e) {
      console.error("Failed to set titlebar visibility:", e);
    }
  };

  const checkForUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const result = await invoke<string | null>("check_for_update");
      setLastChecked(new Date());
      if (result) {
        setUpdateVersion(result);
        setUpdateStatus("installed");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch (e) {
      console.error("Update check failed:", e);
      setUpdateStatus("error");
    }
  };

  const formatLastChecked = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 5) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  };

  if (!settings) {
    return <div className="loading">Loading settings...</div>;
  }

  return (
    <div className="settings-section">
      <h2>General Settings</h2>

      <div className="field-group">
        <span className="field-group-title">Appearance</span>
        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.show_in_dock}
              onChange={(e) => toggleDock(e.target.checked)}
            />
            Show in Dock
          </label>
          <span className="hint">When disabled, ClawTab runs as a menu bar-only app</span>
        </div>
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
        <span className="field-group-title">About</span>
        <div className="form-group">
          <label>Version</label>
          <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
            {version || "..."}
          </span>
        </div>
        <div className="form-group">
          <label>Updates</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="btn"
              disabled={updateStatus === "checking"}
              onClick={checkForUpdate}
            >
              {updateStatus === "checking" ? "Checking..." : "Check for updates"}
            </button>
            {updateStatus === "up-to-date" && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Up to date
              </span>
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
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Check failed
              </span>
            )}
          </div>
          {lastChecked && (
            <span className="hint">
              Last checked: {formatLastChecked(lastChecked)}
            </span>
          )}
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.auto_update_enabled}
              onChange={(e) =>
                update({ auto_update_enabled: e.target.checked })
              }
            />
            Automatically check for updates
          </label>
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Usage</span>
        <div className="form-group">
          <label>Provider Usage</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <button
              className="btn"
              disabled={usageLoading}
              onClick={() => void refreshUsage()}
            >
              {usageLoading ? "Refreshing..." : "Refresh usage"}
            </button>
            {usage?.refreshed_at && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Updated {formatLastChecked(new Date(usage.refreshed_at))}
              </span>
            )}
          </div>
          {usageError && (
            <span className="hint">Failed to load usage: {usageError}</span>
          )}
          <div className="usage-grid">
            {usage ? (
              <>
                <UsageCard title="Claude" usage={usage.claude} />
                <UsageCard title="Codex" usage={usage.codex} />
                <UsageCard title="OpenCode" usage={usage.opencode} />
                <UsageCard title="z.ai" usage={usage.zai} />
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
              const base = window.location.origin;
              new WebviewWindow("setup-wizard", {
                url: `${base}/settings.html?setup`,
                title: "ClawTab Setup",
                width: 640,
                height: 520,
                center: true,
              });
            }}
          >
            Run Setup Wizard
          </button>
        </div>
        <div className="form-group">
          <label>Tools</label>
          <div>
            <button
              className="btn"
              onClick={() => setShowToolsModal(true)}
            >
              Manage Tools
            </button>
            <span className="hint">Detect and configure CLI tools</span>
          </div>
        </div>
        <div className="form-group">
          <label>Logs</label>
          <div>
            <button
              className="btn"
              onClick={() => invoke("open_logs_folder")}
            >
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
            if (e.target === toolsOverlayRef.current) setShowToolsModal(false);
          }}
        >
          <div className="tools-modal">
            <div className="tools-modal-header">
              <h3>Tools</h3>
              <button
                className="btn btn-sm"
                onClick={() => setShowToolsModal(false)}
              >
                Close
              </button>
            </div>
            <ToolsPanel />
          </div>
        </div>
      )}
    </div>
  );
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
  );
}
