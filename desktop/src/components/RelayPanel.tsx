import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShareSection } from "@clawtab/shared";
import type { ShareInfo, SharedWithMeInfo } from "@clawtab/shared";

const GOOGLE_CLIENT_ID =
  "186596496380-dp282va1mvdhrr2q7qrlbgmn3ak2mq07.apps.googleusercontent.com";

const APPLE_WEB_CLIENT_ID = "cc.clawtab.web";

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
  subscription_required: boolean;
  server_url: string;
  device_name: string;
}

interface PairDeviceResponse {
  device_id: string;
  device_token: string;
}

interface SharesResponse {
  shared_by_me: ShareInfo[];
  shared_with_me: SharedWithMeInfo[];
}

interface RelayPanelProps {
  externalAccessToken?: string | null;
  externalRefreshToken?: string | null;
  onExternalTokenConsumed?: () => void;
}

export function RelayPanel({ externalAccessToken, externalRefreshToken, onExternalTokenConsumed }: RelayPanelProps) {
  const [settings, setSettings] = useState<RelaySettings | null>(null);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);

  // Setup form state
  const [serverUrl, setServerUrl] = useState("https://relay.clawtab.cc");
  const [deviceName, setDeviceName] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [editingServerUrl, setEditingServerUrl] = useState(false);
  const [tempServerUrl, setTempServerUrl] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Sharing state
  const [shares, setShares] = useState<SharesResponse>({ shared_by_me: [], shared_with_me: [] });
  const [sharesLoading, setSharesLoading] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [removingShare, setRemovingShare] = useState<{ id: string; email: string } | null>(null);

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
      if (externalRefreshToken) {
        invoke("relay_save_tokens", {
          accessToken: externalAccessToken,
          refreshToken: externalRefreshToken,
        }).catch((e) => console.error("Failed to save tokens:", e));
      }
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

  // Load shares and groups when configured
  useEffect(() => {
    if (!isConfigured) return;
    loadShares();
    invoke<string[]>("relay_get_groups").then(setGroups).catch(() => {});
  }, [isConfigured]);

  const loadShares = async () => {
    setSharesLoading(true);
    try {
      const resp = await invoke<SharesResponse>("relay_get_shares");
      setShares(resp);
    } catch (e) {
      console.error("Failed to load shares:", e);
    } finally {
      setSharesLoading(false);
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

  const handleAppleSignIn = async () => {
    const state = btoa("clawtab");
    const redirectUri = `${serverUrl}/auth/apple/callback`;
    const params = new URLSearchParams({
      client_id: APPLE_WEB_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code id_token",
      response_mode: "form_post",
      scope: "name email",
      state,
    });
    await openUrl(`https://appleid.apple.com/auth/authorize?${params}`);
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
      try {
        await invoke("relay_connect");
      } catch {
        // will retry on next app start
      }
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

  const handleAddShare = useCallback(async (shareEmail: string) => {
    await invoke<ShareInfo>("relay_add_share", {
      email: shareEmail,
      allowedGroups: null,
    });
    await loadShares();
  }, []);

  const handleToggleGroup = useCallback((shareId: string, group: string) => {
    const share = shares.shared_by_me.find((s) => s.id === shareId);
    if (!share) return;

    let newGroups: string[] | null;
    if (share.allowed_groups === null) {
      newGroups = groups.filter((g) => g !== group);
    } else if (share.allowed_groups.includes(group)) {
      newGroups = share.allowed_groups.filter((g) => g !== group);
      if (newGroups.length === 0) newGroups = null;
    } else {
      newGroups = [...share.allowed_groups, group];
      if (groups.every((g) => newGroups!.includes(g))) {
        newGroups = null;
      }
    }

    // Optimistic update
    setShares((prev) => ({
      ...prev,
      shared_by_me: prev.shared_by_me.map((s) =>
        s.id === shareId ? { ...s, allowed_groups: newGroups } : s,
      ),
    }));

    invoke("relay_update_share", { shareId, allowedGroups: newGroups }).catch(() => loadShares());
  }, [shares, groups]);

  const handleRemoveShare = useCallback(async (id: string) => {
    await invoke("relay_remove_share", { shareId: id });
    setRemovingShare(null);
    await loadShares();
  }, []);

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
                {loginError && (
                  <div style={{ color: "var(--danger-color)", fontSize: 12, marginBottom: 12 }}>
                    {loginError}
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
                  <button
                    className="btn"
                    onClick={handleAppleSignIn}

                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    Sign in with Apple
                  </button>

                  <button
                    className="btn"
                    onClick={handleGoogleSignIn}

                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    Sign in with Google
                  </button>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      Server: {serverUrl}
                    </span>
                    <button
                      className="btn"
                      style={{ fontSize: 11, padding: "2px 8px", minHeight: 0 }}
                      onClick={() => { setTempServerUrl(serverUrl); setEditingServerUrl(true); }}
                    >
                      Edit
                    </button>
                  </div>

                  {editingServerUrl && (
                    <div style={{ marginTop: 8, display: "flex", gap: 8, maxWidth: 400 }}>
                      <input
                        type="text"
                        value={tempServerUrl}
                        onChange={(e) => setTempServerUrl(e.target.value)}
                        placeholder="https://relay.clawtab.cc"
                        style={{ flex: 1 }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setServerUrl(tempServerUrl);
                            setEditingServerUrl(false);
                          } else if (e.key === "Escape") {
                            setEditingServerUrl(false);
                          }
                        }}
                        autoFocus
                      />
                      <button
                        className="btn btn-primary"
                        onClick={() => { setServerUrl(tempServerUrl); setEditingServerUrl(false); }}
                      >
                        Save
                      </button>
                      <button
                        className="btn"
                        onClick={() => setEditingServerUrl(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
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
                    background: status?.connected
                      ? "var(--success-color)"
                      : status?.subscription_required
                        ? "#d97706"
                        : "var(--text-secondary)",
                    display: "inline-block",
                  }}
                />
                <span style={{ fontSize: 13, color: status?.subscription_required ? "#d97706" : undefined }}>
                  {status?.connected
                    ? "Connected"
                    : status?.subscription_required
                      ? "No subscription"
                      : "Disconnected"}
                </span>
              </div>
              {status?.subscription_required && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 10px 0" }}>
                    A subscription is required to use remote access.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        try {
                          const resp = await fetch("https://backend.clawtab.cc/subscription/payment-link");
                          const { url } = await resp.json();
                          await openUrl(url);
                        } catch {
                          await openUrl("https://buy.stripe.com/14AdRaemTbqlaF2bUL0Jq01");
                        }
                      }}
                    >
                      Subscribe
                    </button>
                    <button
                      className="btn"
                      disabled={refreshing}
                      onClick={async () => {
                        setRefreshing(true);
                        try {
                          await invoke("relay_disconnect");
                          await invoke("relay_connect");
                          await new Promise((r) => setTimeout(r, 2000));
                        } catch {}
                        const st = await invoke<RelayStatus>("get_relay_status");
                        setStatus(st);
                        setRefreshing(false);
                      }}
                    >
                      {refreshing ? "Refreshing..." : "Refresh"}
                    </button>
                  </div>
                </div>
              )}
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

          <div className="field-group">
            <span className="field-group-title">Sharing</span>
            <p className="section-description" style={{ marginTop: 0 }}>
              Share access to your jobs with other users.
            </p>
            <ShareSection
              sharedByMe={shares.shared_by_me}
              sharedWithMe={shares.shared_with_me}
              availableGroups={groups}
              loading={sharesLoading}
              onAdd={handleAddShare}
              onToggleGroup={handleToggleGroup}
              onRemove={(id, shareEmail) => setRemovingShare({ id, email: shareEmail })}
            />
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

          {removingShare && (
            <ConfirmDialog
              message={`Remove shared access for ${removingShare.email}?`}
              onConfirm={() => handleRemoveShare(removingShare.id)}
              onCancel={() => setRemovingShare(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
