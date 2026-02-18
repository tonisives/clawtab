import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
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

  if (!settings) {
    return <div className="loading">Loading settings...</div>;
  }

  return (
    <div className="settings-section">
      <h2>General Settings</h2>

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
    </div>
  );
}
