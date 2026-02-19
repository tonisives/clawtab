import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TelegramConfig } from "../types";

interface BotInfo {
  username: string;
  id: number;
}

interface Props {
  onComplete: (config: TelegramConfig) => void;
  /** Hide the outer border/heading when embedded in the setup wizard */
  embedded?: boolean;
  /** Pre-populate from an existing config */
  initialConfig?: TelegramConfig | null;
}

export function TelegramSetup({ onComplete, embedded, initialConfig }: Props) {
  const [token, setToken] = useState("");
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [chatIds, setChatIds] = useState<number[]>([]);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const initializedRef = useRef(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const completedRef = useRef(false);

  // Resume from existing config
  useEffect(() => {
    if (initializedRef.current || !initialConfig) return;
    initializedRef.current = true;
    const t = initialConfig.bot_token;
    setToken(t);
    tokenRef.current = t;
    if (initialConfig.chat_ids.length > 0) {
      setChatIds(initialConfig.chat_ids);
      completedRef.current = true;
    }
    if (t) {
      (async () => {
        setValidating(true);
        setTokenError(null);
        try {
          const info = await invoke<BotInfo>("validate_bot_token", { botToken: t });
          setBotInfo(info);
          if (initialConfig.chat_ids.length === 0) {
            startPolling();
          }
        } catch (e) {
          setTokenError(String(e));
        } finally {
          setValidating(false);
        }
      })();
    }
  }, [initialConfig]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      invoke("stop_setup_polling").catch(() => {});
    };
  }, []);

  // Auto-call onComplete when setup is ready
  useEffect(() => {
    if (botInfo && chatIds.length > 0 && !completedRef.current) {
      completedRef.current = true;
      onComplete({
        bot_token: token,
        chat_ids: chatIds,
        notify_on_success: true,
        notify_on_failure: true,
        agent_enabled: true,
      });
    }
  }, [botInfo, chatIds, token, onComplete]);

  const saveConfig = async (botToken: string, ids: number[]) => {
    const config: TelegramConfig = {
      bot_token: botToken,
      chat_ids: ids,
      notify_on_success: true,
      notify_on_failure: true,
      agent_enabled: true,
    };
    try {
      await invoke("set_telegram_config", { config });
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

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
      await saveConfig(t, chatIds);
      // Auto-start polling once token is validated
      startPolling();
    } catch (e) {
      setBotInfo(null);
      setTokenError(String(e));
    } finally {
      setValidating(false);
    }
  };

  const handleTokenChange = (value: string) => {
    setToken(value);
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
    invoke("reset_poll_offset").catch(() => {});

    pollRef.current = setInterval(async () => {
      pollCountRef.current += 1;
      if (pollCountRef.current > 10) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPolling(false);
        invoke("stop_setup_polling").catch(() => {});
        return;
      }
      const currentToken = tokenRef.current;
      try {
        const id = await invoke<number | null>("poll_telegram_updates", { botToken: currentToken });
        if (id !== null) {
          setChatIds((prev) => {
            if (prev.includes(id)) return prev;
            const updated = [...prev, id];
            saveConfig(currentToken, updated);
            // Send confirmation to the newly detected chat
            invoke("test_telegram", { botToken: currentToken, chatId: id }).catch(() => {});
            return updated;
          });
          pollCountRef.current = 0;
        }
      } catch {
        // Ignore poll errors
      }
    }, 3000);
  };

  const removeChatId = (id: number) => {
    const updated = chatIds.filter((c) => c !== id);
    setChatIds(updated);
    saveConfig(token, updated);
    if (updated.length === 0) {
      completedRef.current = false;
    }
  };

  const [testingChat, setTestingChat] = useState<number | null>(null);
  const testChat = async (chatId: number) => {
    setTestingChat(chatId);
    try {
      await invoke("test_telegram", { botToken: token, chatId });
    } catch {
      // ignore
    } finally {
      setTestingChat(null);
    }
  };

  const containerStyle = embedded
    ? {}
    : { border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginBottom: 20 };

  const stepDone = (done: boolean) => ({
    opacity: done ? 0.6 : 1,
  });

  return (
    <div style={containerStyle}>
      {!embedded && <h3 style={{ marginTop: 0 }}>Telegram Setup</h3>}

      {/* Step 1: Bot Token */}
      <div style={stepDone(!!botInfo)}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>
            {botInfo ? "1. Bot created" : "1. Create a bot"}
          </strong>
          {botInfo && (
            <span style={{ color: "var(--success-color)", fontSize: 12 }}>
              @{botInfo.username}
            </span>
          )}
        </div>

        {!botInfo && (
          <div>
            <p className="section-description" style={{ marginTop: 0 }}>
              Open @BotFather in Telegram, send <code>/newbot</code>, follow the prompts, then paste the token below.
            </p>
            <button
              className="btn btn-sm"
              onClick={() => openUrl("https://t.me/BotFather")}
              style={{ marginBottom: 12 }}
            >
              Open @BotFather
            </button>
          </div>
        )}

        <div className="form-group">
          <label>Bot Token</label>
          <input
            type={botInfo ? "password" : "text"}
            value={token}
            onChange={(e) => handleTokenChange(e.target.value)}
            placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
            style={{ maxWidth: "100%" }}
          />
          {tokenError && (
            <span style={{ color: "var(--danger-color)", fontSize: 12 }}>
              {tokenError}
            </span>
          )}
        </div>
      </div>

      {validating && (
        <div style={{
          textAlign: "center",
          padding: "24px 0",
          margin: "16px 0",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}>
          <div className="text-secondary" style={{ fontSize: 14, marginBottom: 4 }}>
            Validating bot token...
          </div>
          <div className="text-secondary" style={{ fontSize: 12 }}>
            Connecting to Telegram API
          </div>
        </div>
      )}

      {/* Step 2: Connect chats */}
      <div style={{ marginTop: 16, ...(!botInfo ? { opacity: 0.4, pointerEvents: "none" as const } : {}) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>2. Connect chats</strong>
          {chatIds.length > 0 && (
            <span style={{ color: "var(--success-color)", fontSize: 12 }}>
              {chatIds.length} connected
            </span>
          )}
        </div>

        <p className="section-description" style={{ marginTop: 0 }}>
          Send <code>/start</code> to your bot for personal chat, or add the bot to a group.
        </p>

        {botInfo && (
          <button
            className="btn btn-sm"
            onClick={() => openUrl(`https://t.me/${botInfo.username}`)}
            style={{ marginBottom: 12 }}
          >
            Open @{botInfo.username}
          </button>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <label style={{ fontSize: 12, margin: 0 }}>Connected chats:</label>
            <button
              className="btn btn-sm"
              onClick={startPolling}
              disabled={polling}
              style={{ fontSize: 11, padding: "1px 8px" }}
            >
              {polling ? "Listening..." : "Refresh"}
            </button>
          </div>
          {chatIds.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {chatIds.map((id) => (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      fontSize: 12,
                    }}
                  >
                    <code>{id}</code>
                    <button
                      onClick={() => removeChatId(id)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-secondary)",
                        padding: 0,
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                      title="Remove"
                    >
                      x
                    </button>
                  </span>
                  <button
                    className="btn btn-sm"
                    onClick={() => testChat(id)}
                    disabled={testingChat === id}
                    style={{ fontSize: 11, padding: "1px 8px" }}
                  >
                    {testingChat === id ? "Sending..." : "Send test message"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-secondary" style={{ fontSize: 12 }}>
              None detected yet.
            </span>
          )}
          {polling && (
            <p className="text-secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              Send <code>/start</code> to your bot or add it to a group...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
