import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TelegramConfig } from "../types";
import { TelegramSetup } from "./TelegramSetup";
import { ConfirmDialog } from "./ConfirmDialog";

export function TelegramPanel() {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notifySuccess, setNotifySuccess] = useState(true);
  const [notifyFailure, setNotifyFailure] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);

  useEffect(() => {
    invoke<TelegramConfig | null>("get_telegram_config").then((cfg) => {
      if (cfg) {
        setConfig(cfg);
        setNotifySuccess(cfg.notify_on_success);
        setNotifyFailure(cfg.notify_on_failure);
        setAgentEnabled(cfg.agent_enabled);
      }
      setLoaded(true);
    });
  }, []);

  const handleSetupComplete = (newConfig: TelegramConfig) => {
    setConfig(newConfig);
    setNotifySuccess(newConfig.notify_on_success);
    setNotifyFailure(newConfig.notify_on_failure);
    setAgentEnabled(newConfig.agent_enabled);
  };

  const saveSettings = async (overrides: Partial<TelegramConfig>) => {
    if (!config) return;
    const updated: TelegramConfig = { ...config, ...overrides };
    try {
      await invoke("set_telegram_config", { config: updated });
      setConfig(updated);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

  const handleDisable = async () => {
    try {
      await invoke("set_telegram_config", { config: null });
      setConfig(null);
    } catch (e) {
      console.error("Failed to disable telegram:", e);
    }
  };

  if (!loaded) return null;

  const isConfigured = config && config.chat_ids.length > 0;

  return (
    <div className="settings-section">
      <h2>Telegram</h2>
      <p className="section-description">
        Receive job completion notifications and send commands via Telegram bot.
      </p>

      <div className="field-group">
        <span className="field-group-title">Setup</span>
        <TelegramSetup
          onComplete={handleSetupComplete}
          initialConfig={config}
        />
      </div>

      {isConfigured && (
        <>
          <div className="field-group">
            <span className="field-group-title">Notifications</span>

            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={notifySuccess}
                  onChange={(e) => {
                    setNotifySuccess(e.target.checked);
                    saveSettings({ notify_on_success: e.target.checked });
                  }}
                />{" "}
                Notify on job success
              </label>
            </div>

            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={notifyFailure}
                  onChange={(e) => {
                    setNotifyFailure(e.target.checked);
                    saveSettings({ notify_on_failure: e.target.checked });
                  }}
                />{" "}
                Notify on job failure
              </label>
            </div>
          </div>

          <div className="field-group">
            <span className="field-group-title">Agent Mode</span>
            <p className="section-description" style={{ marginTop: 0 }}>
              When enabled, the bot responds to commands from the allowed chat IDs.
              The bot polls for messages and executes commands.
            </p>

            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={agentEnabled}
                  onChange={(e) => {
                    setAgentEnabled(e.target.checked);
                    saveSettings({ agent_enabled: e.target.checked });
                  }}
                />{" "}
                Enable agent mode
              </label>
            </div>

            {agentEnabled && (
              <div className="terminal-preview">
                <div className="terminal-header">
                  <span>commands</span>
                </div>
                <pre className="terminal-body">
{`/jobs    - List all configured jobs
/status  - Show job statuses
/run <name>    - Run a job
/pause <name>  - Pause a running job
/resume <name> - Resume a paused job
/help    - Show help`}
                </pre>
              </div>
            )}
          </div>

          <div className="field-group" style={{ borderColor: "var(--danger-color)" }}>
            <span className="field-group-title" style={{ color: "var(--danger-color)" }}>Danger Zone</span>
            <p className="section-description" style={{ marginTop: 0 }}>
              This removes your bot token and all chat IDs. You will need to set up Telegram again.
            </p>
            <button className="btn btn-danger" onClick={() => setShowConfirmRemove(true)}>
              Remove Telegram Configuration
            </button>

            {showConfirmRemove && (
              <ConfirmDialog
                message="Remove all Telegram configuration? This deletes your bot token and all chat IDs. You will need to set up Telegram again."
                onConfirm={() => { handleDisable(); setShowConfirmRemove(false); }}
                onCancel={() => setShowConfirmRemove(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
