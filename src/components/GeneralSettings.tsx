import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, ToolInfo } from "../types";

const EDITOR_OPTIONS: { value: string; label: string }[] = [
  { value: "nvim", label: "Neovim" },
  { value: "vim", label: "Vim" },
  { value: "code", label: "VS Code" },
  { value: "codium", label: "VSCodium" },
  { value: "zed", label: "Zed" },
  { value: "hx", label: "Helix" },
  { value: "subl", label: "Sublime Text" },
  { value: "emacs", label: "Emacs" },
];

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [availableEditors, setAvailableEditors] = useState<string[]>([]);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
    invoke<ToolInfo[]>("detect_tools").then((tools) => {
      const editors = tools
        .filter((t) => t.group === "editor" && t.available)
        .map((t) => t.name);
      setAvailableEditors(editors);
    });
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

      <div className="form-group">
        <label>Secrets Backend</label>
        <select
          value={settings.secrets_backend}
          onChange={(e) => update({ secrets_backend: e.target.value })}
        >
          <option value="both">Both (Keychain + gopass)</option>
          <option value="keychain">Keychain only</option>
          <option value="gopass">gopass only</option>
        </select>
        <span className="hint">Which secret stores to use for injecting environment variables</span>
      </div>

      <div className="form-group">
        <label>Editor</label>
        <select
          value={settings.preferred_editor}
          onChange={(e) => update({ preferred_editor: e.target.value })}
        >
          {EDITOR_OPTIONS.filter((e) => availableEditors.includes(e.value)).map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
        <span className="hint">Editor used for opening job config files</span>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "24px 0" }} />

      <div className="form-group">
        <label>Setup Wizard</label>
        <p className="section-description" style={{ marginBottom: 8 }}>
          Re-run the initial setup wizard to detect tools and configure defaults.
        </p>
        <button
          className="btn"
          onClick={() => {
            new WebviewWindow("setup-wizard", {
              url: "/settings.html?setup",
              title: "ClawdTab Setup",
              width: 640,
              height: 520,
              center: true,
            });
          }}
        >
          Run Setup Wizard
        </button>
      </div>
    </div>
  );
}
