import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TelegramConfig } from "../types";

interface BotInfo {
  username: string;
  id: number;
}

type SetupStep = "token" | "connect" | "done";

function TelegramSetup({ onComplete }: { onComplete: (config: TelegramConfig) => void }) {
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<number | null>(null);
  const [manualChatId, setManualChatId] = useState("");
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const validateToken = async (t: string) => {
    if (!t || !t.includes(":")) {
      setBotInfo(null);
      setTokenError(null);
      return;
    }
    setValidating(true);
    setTokenError(null);
    try {
      const info = await invoke<BotInfo>("validate_bot_token", { botToken: t });
      setBotInfo(info);
      setTokenError(null);
    } catch (e) {
      setBotInfo(null);
      setTokenError(String(e));
    } finally {
      setValidating(false);
    }
  };

  const handleTokenChange = (value: string) => {
    setToken(value);
    // Auto-validate when it looks like a token
    if (value.includes(":") && value.length > 20) {
      validateToken(value);
    } else {
      setBotInfo(null);
      setTokenError(null);
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollCountRef.current = 0;
    setPolling(true);

    pollRef.current = setInterval(async () => {
      pollCountRef.current += 1;
      // Stop after ~30s (10 polls at 3s intervals)
      if (pollCountRef.current > 10) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPolling(false);
        return;
      }
      try {
        const id = await invoke<number | null>("poll_telegram_updates", { botToken: token });
        if (id !== null) {
          setChatId(id);
          if (pollRef.current) clearInterval(pollRef.current);
          setPolling(false);
        }
      } catch {
        // Ignore poll errors
      }
    }, 3000);
  };

  const goToConnect = () => {
    setStep("connect");
    startPolling();
  };

  const goToDone = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setPolling(false);
    setStep("done");
  };

  const resolvedChatId = chatId ?? (manualChatId ? parseInt(manualChatId, 10) : null);

  const handleFinish = () => {
    if (!botInfo || !resolvedChatId || isNaN(resolvedChatId)) return;
    onComplete({
      bot_token: token,
      chat_ids: [resolvedChatId],
      notify_on_success: true,
      notify_on_failure: true,
      agent_enabled: false,
    });
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Telegram Setup</h3>

      {/* Progress */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["token", "connect", "done"] as SetupStep[]).map((s, idx) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: idx <= ["token", "connect", "done"].indexOf(step)
                ? "var(--accent)"
                : "var(--border)",
            }}
          />
        ))}
      </div>

      {step === "token" && (
        <div>
          <p className="section-description">
            Create a Telegram bot to receive notifications and send commands.
            Open @BotFather, send <code>/newbot</code>, follow the prompts, then paste the token below.
          </p>

          <button
            className="btn btn-sm"
            onClick={() => openUrl("https://t.me/BotFather")}
            style={{ marginBottom: 12 }}
          >
            Open @BotFather
          </button>

          <div className="form-group">
            <label>Bot Token</label>
            <input
              type="text"
              value={token}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
              style={{ maxWidth: "100%" }}
            />
            {validating && (
              <span className="text-secondary" style={{ fontSize: 12 }}>Validating...</span>
            )}
            {botInfo && (
              <span style={{ color: "var(--success-color)", fontSize: 12 }}>
                Bot verified: @{botInfo.username}
              </span>
            )}
            {tokenError && (
              <span style={{ color: "var(--danger-color)", fontSize: 12 }}>
                {tokenError}
              </span>
            )}
          </div>

          <div className="btn-group">
            <button
              className="btn btn-primary"
              onClick={goToConnect}
              disabled={!botInfo}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === "connect" && botInfo && (
        <div>
          <p className="section-description">
            Open your bot in Telegram and send <code>/start</code> to connect your chat.
            ClawdTab will detect your chat ID automatically.
          </p>

          <button
            className="btn btn-sm"
            onClick={() => openUrl(`https://t.me/${botInfo.username}`)}
            style={{ marginBottom: 12 }}
          >
            Open @{botInfo.username}
          </button>

          {polling && !chatId && (
            <p className="text-secondary" style={{ fontSize: 12 }}>
              Waiting for your message...
            </p>
          )}

          {chatId && (
            <p style={{ color: "var(--success-color)", fontSize: 12 }}>
              Chat ID detected: <code>{chatId}</code>
            </p>
          )}

          {!chatId && (
            <div className="form-group" style={{ marginTop: 12 }}>
              <label>Or enter chat ID manually</label>
              <input
                type="text"
                value={manualChatId}
                onChange={(e) => setManualChatId(e.target.value)}
                placeholder="123456789"
                style={{ maxWidth: 200 }}
              />
              <span className="hint">
                Send any message to @userinfobot to find your chat ID
              </span>
            </div>
          )}

          <div className="btn-group" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setStep("token")}>
              Back
            </button>
            <button
              className="btn btn-primary"
              onClick={goToDone}
              disabled={!resolvedChatId || isNaN(resolvedChatId)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === "done" && botInfo && (
        <div>
          <p className="section-description">
            Your Telegram bot is ready. Notifications will be sent to your chat.
            You can enable agent mode after setup to control jobs via Telegram.
          </p>
          <div style={{ marginBottom: 12 }}>
            <p><strong>Bot:</strong> @{botInfo.username}</p>
            <p><strong>Chat ID:</strong> {resolvedChatId}</p>
          </div>

          <div className="btn-group">
            <button className="btn" onClick={() => setStep("connect")}>
              Back
            </button>
            <button
              className="btn btn-primary"
              onClick={handleFinish}
            >
              Save & Finish
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [showSetup, setShowSetup] = useState(false);

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

  const applyConfig = (cfg: TelegramConfig) => {
    setConfig(cfg);
    setBotToken(cfg.bot_token);
    setChatIdsText(cfg.chat_ids.join(", "));
    setNotifySuccess(cfg.notify_on_success);
    setNotifyFailure(cfg.notify_on_failure);
    setAgentEnabled(cfg.agent_enabled);
    if (cfg.chat_ids.length > 0) {
      setTestChatId(String(cfg.chat_ids[0]));
    }
  };

  const handleSetupComplete = async (newConfig: TelegramConfig) => {
    try {
      await invoke("set_telegram_config", { config: newConfig });
      applyConfig(newConfig);
      setShowSetup(false);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

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
      </p>

      {!config && !showSetup && (
        <div style={{ marginBottom: 20 }}>
          <button
            className="btn btn-primary"
            onClick={() => setShowSetup(true)}
          >
            Setup Telegram
          </button>
          <span className="text-secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            Guided setup to create a bot and connect your chat
          </span>
        </div>
      )}

      {showSetup && (
        <TelegramSetup onComplete={handleSetupComplete} />
      )}

      {config && (
        <>
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
            <button className="btn btn-danger" onClick={handleDisable}>
              Disable
            </button>
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
        </>
      )}
    </div>
  );
}
