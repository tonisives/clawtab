import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TelegramConfig } from "../types";

export function TelegramPanel() {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [botToken, setBotToken] = useState("");
  const [chatIdsText, setChatIdsText] = useState("");
  const [notifySuccess, setNotifySuccess] = useState(true);
  const [notifyFailure, setNotifyFailure] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [testChatId, setTestChatId] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    invoke<TelegramConfig | null>("get_telegram_config").then((cfg) => {
      if (cfg) {
        setConfig(cfg);
        setBotToken(cfg.bot_token);
        setChatIdsText(cfg.chat_ids.join(", "));
        setNotifySuccess(cfg.notify_on_success);
        setNotifyFailure(cfg.notify_on_failure);
        setAgentEnabled(cfg.agent_enabled);
        if (cfg.chat_ids.length > 0) {
          setTestChatId(String(cfg.chat_ids[0]));
        }
      }
    });
  }, []);

  const handleSave = async () => {
    const chatIds = chatIdsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));

    const newConfig: TelegramConfig = {
      bot_token: botToken,
      chat_ids: chatIds,
      notify_on_success: notifySuccess,
      notify_on_failure: notifyFailure,
      agent_enabled: agentEnabled,
    };

    try {
      await invoke("set_telegram_config", { config: newConfig });
      setConfig(newConfig);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

  const handleDisable = async () => {
    try {
      await invoke("set_telegram_config", { config: null });
      setConfig(null);
      setBotToken("");
      setChatIdsText("");
      setAgentEnabled(false);
    } catch (e) {
      console.error("Failed to disable telegram:", e);
    }
  };

  const handleTest = async () => {
    if (!botToken || !testChatId) return;
    setTesting(true);
    setTestResult(null);
    try {
      await invoke("test_telegram", {
        botToken,
        chatId: parseInt(testChatId, 10),
      });
      setTestResult("Test message sent successfully.");
    } catch (e) {
      setTestResult(`Failed: ${e}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-section">
      <h2>Telegram</h2>
      <p className="section-description">
        Receive job completion notifications and send commands via Telegram bot.
        Create a bot with @BotFather and get your chat ID from @userinfobot.
      </p>

      <div className="form-group">
        <label>Bot Token</label>
        <input
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
          style={{ maxWidth: "100%" }}
        />
      </div>

      <div className="form-group">
        <label>Chat IDs</label>
        <input
          type="text"
          value={chatIdsText}
          onChange={(e) => setChatIdsText(e.target.value)}
          placeholder="123456789, -100123456789"
          style={{ maxWidth: "100%" }}
        />
        <span className="hint">Comma-separated chat IDs for notifications and agent commands</span>
      </div>

      <h3>Notifications</h3>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={notifySuccess}
            onChange={(e) => setNotifySuccess(e.target.checked)}
          />{" "}
          Notify on job success
        </label>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={notifyFailure}
            onChange={(e) => setNotifyFailure(e.target.checked)}
          />{" "}
          Notify on job failure
        </label>
      </div>

      <h3>Agent Mode</h3>
      <p className="section-description">
        When enabled, the bot responds to commands from the allowed chat IDs.
        The bot polls for messages and executes commands.
      </p>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={agentEnabled}
            onChange={(e) => setAgentEnabled(e.target.checked)}
          />{" "}
          Enable agent mode
        </label>
      </div>

      {agentEnabled && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 12, marginBottom: 16 }}>
          <p className="text-secondary" style={{ margin: "0 0 8px 0" }}>Available commands:</p>
          <pre style={{ margin: 0, fontSize: 12 }}>
{`/jobs    - List all configured jobs
/status  - Show job statuses
/run <name>    - Run a job
/pause <name>  - Pause a running job
/resume <name> - Resume a paused job
/help    - Show help`}
          </pre>
        </div>
      )}

      <div className="btn-group" style={{ marginBottom: 20 }}>
        <button className="btn btn-primary" onClick={handleSave}>
          Save
        </button>
        {config && (
          <button className="btn btn-danger" onClick={handleDisable}>
            Disable
          </button>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <h3>Test Connection</h3>
        <div className="form-row" style={{ alignItems: "flex-end" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Chat ID</label>
            <input
              type="text"
              value={testChatId}
              onChange={(e) => setTestChatId(e.target.value)}
              placeholder="123456789"
            />
          </div>
          <div className="form-group" style={{ flex: "none" }}>
            <button
              className="btn btn-sm"
              onClick={handleTest}
              disabled={testing || !botToken || !testChatId}
            >
              {testing ? "Sending..." : "Send Test"}
            </button>
          </div>
        </div>
        {testResult && (
          <p
            className={
              testResult.startsWith("Failed") ? "text-danger" : "text-secondary"
            }
          >
            {testResult}
          </p>
        )}
      </div>
    </div>
  );
}
