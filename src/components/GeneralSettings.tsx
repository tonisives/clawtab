import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings } from "../types";

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "up-to-date" | "installed" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
    invoke<string>("get_version").then(setVersion);
  }, []);

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
                v{updateVersion} installed --{" "}
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
    </div>
  );
}
