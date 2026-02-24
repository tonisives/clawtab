import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConfirmDialog } from "./ConfirmDialog";

const GOOGLE_CLIENT_ID =
  "186596496380-dp282va1mvdhrr2q7qrlbgmn3ak2mq07.apps.googleusercontent.com";

interface RelaySettings {
  enabled: boolean;
  server_url: string;
  device_token: string;
  device_id: string;
  device_name: string;
}

interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  server_url: string;
  device_name: string;
}

interface LoginResponse {
  access_token: string;
  refresh_token: string;
}

interface PairDeviceResponse {
  device_id: string;
  device_token: string;
}

interface RelayPanelProps {
  externalAccessToken?: string | null;
  onExternalTokenConsumed?: () => void;
}

export function RelayPanel({ externalAccessToken, onExternalTokenConsumed }: RelayPanelProps) {
  const [settings, setSettings] = useState<RelaySettings | null>(null);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);

  // Setup form state
  const [serverUrl, setServerUrl] = useState("https://relay.clawtab.cc");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<RelaySettings | null>("get_relay_settings"),
      invoke<RelayStatus>("get_relay_status"),
      invoke<string>("get_hostname"),
    ]).then(([s, st, hostname]) => {
      setSettings(s);
      setStatus(st);
      if (s) {
        setServerUrl(s.server_url || "https://relay.clawtab.cc");
        setDeviceName(s.device_name || "");
      } else {
        setDeviceName(hostname || "");
      }
      setLoaded(true);
    });
  }, []);

  // Accept access token from deep link callback
  useEffect(() => {
    if (externalAccessToken) {
      setAccessToken(externalAccessToken);
      setLoginError(null);
      onExternalTokenConsumed?.();
    }
  }, [externalAccessToken]);

  // Poll connection status
  useEffect(() => {
    if (!loaded) return;
    const interval = setInterval(() => {
      invoke<RelayStatus>("get_relay_status").then(setStatus);
    }, 5000);
    return () => clearInterval(interval);
  }, [loaded]);

  const isConfigured = settings && settings.device_token && settings.server_url;

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const resp = await invoke<LoginResponse>("relay_login", {
        req: { server_url: serverUrl, email, password },
      });
      setAccessToken(resp.access_token);
      setPassword("");
    } catch (e) {
      setLoginError(String(e));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleGoogleSignIn = async () => {
    const state = btoa("clawtab");
    const redirectUri = `${serverUrl}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    await openUrl(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  };

  const handlePairDevice = async () => {
    if (!accessToken || !deviceName) return;
    setPairing(true);
    setPairError(null);
    try {
      const resp = await invoke<PairDeviceResponse>("relay_pair_device", {
        req: { server_url: serverUrl, access_token: accessToken, device_name: deviceName },
      });
      const newSettings: RelaySettings = {
        enabled: true,
        server_url: serverUrl,
        device_token: resp.device_token,
        device_id: resp.device_id,
        device_name: deviceName,
      };
      await invoke("set_relay_settings", { settings: newSettings });
      setSettings(newSettings);
      setAccessToken(null);
      // Connect to relay
      try {
        await invoke("relay_connect");
      } catch {
        // will retry on next app start
      }
      // Refresh status
      const st = await invoke<RelayStatus>("get_relay_status");
      setStatus(st);
    } catch (e) {
      setPairError(String(e));
    } finally {
      setPairing(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await invoke("relay_disconnect");
      await invoke("set_relay_settings", {
        settings: { enabled: false, server_url: "", device_token: "", device_id: "", device_name: "" },
      });
      setSettings(null);
      setAccessToken(null);
      setEmail("");
      setPassword("");
      const st = await invoke<RelayStatus>("get_relay_status");
      setStatus(st);
    } catch (e) {
      console.error("Failed to disconnect relay:", e);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!settings) return;
    const updated = { ...settings, enabled };
    try {
      await invoke("set_relay_settings", { settings: updated });
      setSettings(updated);
      if (enabled) {
        await invoke("relay_connect");
      } else {
        await invoke("relay_disconnect");
      }
      const st = await invoke<RelayStatus>("get_relay_status");
      setStatus(st);
    } catch (e) {
      console.error("Failed to toggle relay:", e);
    }
  };

  if (!loaded) {
    return (
      <div className="settings-section">
        <h2>Remote Access</h2>
        <p className="section-description">
          Connect to a relay server to control your jobs from a mobile device.
        </p>
        <div className="field-group">
          <span className="field-group-title">Setup</span>
          <div style={{ opacity: 0.5 }}>
            <div className="skeleton-line" style={{ height: 34, maxWidth: 400, borderRadius: 6 }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2>Remote Access</h2>
      <p className="section-description">
        Connect to a relay server to control your jobs from a mobile device.
      </p>

      {!isConfigured ? (
        <div className="field-group">
          <span className="field-group-title">Setup</span>

          {/* Step 1: Login */}
          <div style={{ opacity: accessToken ? 0.6 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>
                {accessToken ? "1. Logged in" : "1. Log in to relay server"}
              </strong>
              {accessToken && (
                <span style={{ color: "var(--success-color)", fontSize: 12 }}>
                  authenticated
                </span>
              )}
            </div>

            {!accessToken && (
              <>
                <div className="form-group">
                  <label>Server URL</label>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="https://relay.clawtab.cc"
                  />
                  <span className="hint">
                    Use the hosted relay or your own self-hosted instance
                  </span>
                </div>

                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="text"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    disabled={loggingIn}
                  />
                </div>

                <div className="form-group">
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="your password"
                    disabled={loggingIn}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLogin();
                    }}
                  />
                </div>

                {loginError && (
                  <div style={{ color: "var(--danger-color)", fontSize: 12, marginBottom: 12 }}>
                    {loginError}
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleLogin}
                  disabled={loggingIn || !email || !password}
                >
                  {loggingIn ? "Logging in..." : "Log in"}
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0", maxWidth: 400 }}>
                  <div style={{ flex: 1, height: 1, background: "var(--border-color)" }} />
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>or</span>
                  <div style={{ flex: 1, height: 1, background: "var(--border-color)" }} />
                </div>

                <button
                  className="btn"
                  onClick={handleGoogleSignIn}
                  disabled={loggingIn}
                  style={{ width: "100%", maxWidth: 400, boxSizing: "border-box" }}
                >
                  Sign in with Google
                </button>

                {location.port && (
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label>Paste access token (dev)</label>
                    <div style={{ display: "flex", gap: 8, maxWidth: 400 }}>
                      <input
                        id="dev-token-input"
                        type="text"
                        placeholder="access_token from callback URL"
                        style={{ flex: 1 }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) setAccessToken(val);
                          }
                        }}
                      />
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          const el = document.getElementById("dev-token-input") as HTMLInputElement;
                          const val = el?.value.trim();
                          if (val) setAccessToken(val);
                        }}
                      >
                        OK
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Step 2: Pair device */}
          <div style={{ marginTop: 20, ...(!accessToken ? { opacity: 0.4, pointerEvents: "none" as const } : {}) }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>2. Pair this device</strong>
            </div>

            <p className="section-description" style={{ marginTop: 0 }}>
              Give this machine a name so you can identify it from your phone.
            </p>

            <div className="form-group">
              <label>Device Name</label>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="My MacBook Pro"
                disabled={pairing}
              />
            </div>

            {pairError && (
              <div style={{ color: "var(--danger-color)", fontSize: 12, marginBottom: 12 }}>
                {pairError}
              </div>
            )}

            <button
              className="btn btn-primary"
              onClick={handlePairDevice}
              disabled={pairing || !deviceName}
            >
              {pairing ? "Pairing..." : "Pair Device"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="field-group">
            <span className="field-group-title">Connection</span>

            <div className="form-group">
              <label>Status</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: status?.connected ? "var(--success-color)" : "var(--text-secondary)",
                    display: "inline-block",
                  }}
                />
                <span style={{ fontSize: 13 }}>
                  {status?.connected ? "Connected" : "Disconnected"}
                </span>
              </div>
            </div>

            <div className="form-group">
              <label>Server</label>
              <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
                {settings.server_url}
              </span>
            </div>

            <div className="form-group">
              <label>Device</label>
              <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
                {settings.device_name || settings.device_id}
              </span>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => handleToggleEnabled(e.target.checked)}
                />
                Enable remote access
              </label>
            </div>
          </div>

          <div className="field-group" style={{ borderColor: "var(--danger-color)" }}>
            <span className="field-group-title" style={{ color: "var(--danger-color)" }}>Danger Zone</span>
            <p className="section-description" style={{ marginTop: 0 }}>
              This removes the relay configuration and disconnects this device. You will need to pair again.
            </p>
            <button className="btn btn-danger" onClick={() => setShowConfirmRemove(true)}>
              Remove Relay Configuration
            </button>

            {showConfirmRemove && (
              <ConfirmDialog
                message="Remove relay configuration? This disconnects and un-pairs this device. You will need to log in and pair again."
                onConfirm={() => { handleDisconnect(); setShowConfirmRemove(false); }}
                onCancel={() => setShowConfirmRemove(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
