import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktopMachineApi, resetDesktopAccount } from "../machines/connection";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShareSection, retryMachines } from "@clawtab/shared";
import type { ShareInfo, SharedWithMeInfo } from "@clawtab/shared";
import { pollRelayLogin, startRelayLogin } from "../relayLogin";

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
  auth_expired: boolean;
  configured: boolean;
  server_url: string;
  device_name: string;
}

const UNAUTHORIZED_PREFIX = "UNAUTHORIZED:";

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
  let [removingRelay, setRemovingRelay] = useState(false);
  let [removeError, setRemoveError] = useState<string | null>(null);

  // Setup form state
  const [serverUrl, setServerUrl] = useState("https://relay.clawtab.cc");
  const [deviceName, setDeviceName] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  let [loginStatus, setLoginStatus] = useState("");
  let [signingIn, setSigningIn] = useState(false);
  let [checkingAccount, setCheckingAccount] = useState(true);
  let [signingOut, setSigningOut] = useState(false);
  let accountVersion = useRef(0);
  let signingOutRef = useRef(false);
  let ignoreCallbacks = useRef(false);
  let loginAttempt = useRef<AbortController | null>(null);
  let restoringAccount = useRef(false);
  let restoredToken = useRef<string | null>(null);
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

  let restoreAccount = useCallback(async () => {
    if (restoringAccount.current || loginAttempt.current || signingOutRef.current || ignoreCallbacks.current) return;
    let version = accountVersion.current;
    restoringAccount.current = true;
    try {
      let token = await invoke<string | null>("relay_restore_account");
      if (version !== accountVersion.current || loginAttempt.current) return;
      if (token) {
        setAccessToken(token);
        setSigningIn(false);
        setLoginError(null);
        setLoginStatus("Signed in to your account.");
        if (restoredToken.current !== token) retryMachines();
        restoredToken.current = token;
      } else {
        if (restoredToken.current) resetDesktopAccount();
        restoredToken.current = null;
        setAccessToken(null);
        setLoginStatus("");
        setLoginError(null);
      }
    } catch {
      if (version === accountVersion.current && !loginAttempt.current) setLoginError("Could not check your account session. It will be checked again when you return to this window.");
    } finally {
      restoringAccount.current = false;
      if (version === accountVersion.current) setCheckingAccount(false);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void restoreAccount();
    let onVisible = () => { if (!document.hidden) void restoreAccount(); };
    window.addEventListener("focus", restoreAccount);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", restoreAccount);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loaded, restoreAccount]);

  useEffect(() => () => loginAttempt.current?.abort(), []);

  // Accept access token from deep link callback
  useEffect(() => {
    if (externalAccessToken) {
      if (ignoreCallbacks.current || signingOutRef.current) {
        onExternalTokenConsumed?.();
        return;
      }
      let version = ++accountVersion.current;
      loginAttempt.current?.abort();
      loginAttempt.current = null;
      if (externalRefreshToken) {
        invoke("relay_save_tokens", {
          accessToken: externalAccessToken,
          refreshToken: externalRefreshToken,
        }).then(() => {
          if (version !== accountVersion.current) return;
          setAccessToken(externalAccessToken);
          setLoginError(null);
          setSigningIn(false);
          setCheckingAccount(false);
          setLoginStatus("Signed in to your account.");
          restoredToken.current = externalAccessToken;
          retryMachines();
        }).catch(() => {
          if (version !== accountVersion.current) return;
          setSigningIn(false);
          setCheckingAccount(false);
          setLoginStatus("");
          setLoginError("Could not save your account session. Please try signing in again.");
        });
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
    if (!isConfigured || !accessToken) {
      setShares({ shared_by_me: [], shared_with_me: [] });
      return;
    }
    loadShares();
    invoke<string[]>("relay_get_groups").then(setGroups).catch(() => {});
  }, [isConfigured, accessToken]);

  const loadShares = async () => {
    let version = accountVersion.current;
    setSharesLoading(true);
    try {
      const resp = await invoke<SharesResponse>("relay_get_shares");
      if (version === accountVersion.current) setShares(resp);
    } catch (e) {
      console.error("Failed to load shares:", e);
    } finally {
      setSharesLoading(false);
    }
  };

  let signIn = async (provider: "google" | "apple") => {
    accountVersion.current++;
    ignoreCallbacks.current = false;
    setCheckingAccount(false);
    setEditingServerUrl(false);
    loginAttempt.current?.abort();
    let attempt = new AbortController();
    loginAttempt.current = attempt;
    setSigningIn(true);
    setLoginError(null);
    setLoginStatus("Opening sign-in…");
    let timedOut = false;
    let timeout = window.setTimeout(() => { timedOut = true; attempt.abort(); }, 5 * 60_000);
    try {
      let url = await startRelayLogin(serverUrl, provider, attempt.signal, openUrl);
      attempt.signal.throwIfAborted();
      setLoginStatus("Finish signing in in your browser, then return here.");
      while (!attempt.signal.aborted) {
        let tokens = await pollRelayLogin(url, attempt.signal);
        if (tokens) {
          await invoke("relay_save_tokens", { accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
          attempt.signal.throwIfAborted();
          setAccessToken(tokens.access_token);
          restoredToken.current = tokens.access_token;
          setLoginStatus("Signed in to your account.");
          retryMachines();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
      }
    } catch (error) {
      if (!attempt.signal.aborted) {
        setLoginStatus("");
        setLoginError(error instanceof Error ? error.message : "Could not complete sign-in. Please try again.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (loginAttempt.current === attempt) {
        loginAttempt.current = null;
        setSigningIn(false);
        if (timedOut) {
          setLoginStatus("");
          setLoginError("Sign-in timed out. Please start sign-in again.");
        }
      }
    }
  };
  let handleGoogleSignIn = () => signIn("google");
  let handleAppleSignIn = () => signIn("apple");
  let cancelSignIn = () => {
    accountVersion.current++;
    ignoreCallbacks.current = true;
    loginAttempt.current?.abort();
    loginAttempt.current = null;
    setSigningIn(false);
    setLoginStatus("");
    setLoginError(null);
  };

  const handlePairDevice = async () => {
    if (!accessToken || !deviceName) return;
    setPairing(true);
    setPairError(null);
    try {
      const resp = await invoke<PairDeviceResponse>("relay_pair_device", {
        req: { server_url: serverUrl, device_name: deviceName },
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
      try {
        await invoke("relay_connect");
      } catch {
        // will retry on next app start
      }
      const st = await invoke<RelayStatus>("get_relay_status");
      setStatus(st);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith(UNAUTHORIZED_PREFIX)) {
        await invoke("relay_sign_out").catch(() => {});
        setAccessToken(null);
        restoredToken.current = null;
        setLoginStatus("");
        setPairError(null);
        setLoginError("Session expired — please sign in again.");
      } else {
        setPairError(msg);
      }
    } finally {
      setPairing(false);
    }
  };

  const handleSignOut = async () => {
    accountVersion.current++;
    ignoreCallbacks.current = true;
    signingOutRef.current = true;
    setSigningOut(true);
    setLoginError(null);
    loginAttempt.current?.abort();
    loginAttempt.current = null;
    try {
      await invoke("relay_sign_out");
      setAccessToken(null);
      restoredToken.current = null;
      setLoginStatus("");
      setSigningIn(false);
      setCheckingAccount(false);
      setPairError(null);
      setRemovingShare(null);
      setShowConfirmRemove(false);
      setShares({ shared_by_me: [], shared_with_me: [] });
      resetDesktopAccount();
    } catch {
      ignoreCallbacks.current = false;
      setLoginError("Could not sign out. Please try again.");
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  };

  const handleDisconnect = async () => {
    setRemovingRelay(true);
    setRemoveError(null);
    try {
      if (settings?.device_id) {
        try {
          await desktopMachineApi("DELETE", `/devices/${settings.device_id}`);
        } catch (error) {
          if (!(error instanceof Error && error.message === "device not found")) throw error;
        }
      }
      await invoke("relay_disconnect");
      await invoke("set_relay_settings", {
        settings: { enabled: false, server_url: "", device_token: "", device_id: "", device_name: "" },
      });
      setSettings(null);
      const st = await invoke<RelayStatus>("get_relay_status");
      setStatus(st);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Could not remove this machine. Please retry.");
    } finally {
      setRemovingRelay(false);
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

  let accountControls = (
    <>
      <p role="status">
        {checkingAccount ? "Checking your account…"
          : signingOut ? "Signing out…"
          : accessToken ? "Signed in to your account."
          : loginStatus || "Sign in to manage your machines and sharing."}
      </p>
      {loginError && <p role="alert">{loginError}</p>}
      <div className="btn-group">
        {accessToken ? (
          <button className="btn" onClick={handleSignOut} disabled={signingOut || pairing}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        ) : signingIn ? (
          <button className="btn" onClick={cancelSignIn}>Cancel sign-in</button>
        ) : !checkingAccount && (
          <>
            <button className="btn" onClick={handleAppleSignIn}>Sign in with Apple</button>
            <button className="btn" onClick={handleGoogleSignIn}>Sign in with Google</button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="settings-section">
      <h2>Remote Access</h2>
      <p className="section-description">
        Connect to a relay server to control your jobs from a mobile device.
      </p>

      {!isConfigured ? (
        <div className="field-group">
          <span className="field-group-title">Setup</span>

          {status?.auth_expired && !accessToken && !checkingAccount && (
            <div
              style={{
                background: "var(--warning-bg, rgba(217, 119, 6, 0.12))",
                border: "1px solid var(--warning-color, #d97706)",
                borderRadius: 6,
                padding: "10px 12px",
                marginBottom: 16,
                fontSize: 12,
                color: "var(--warning-color, #d97706)",
              }}
            >
              Your session expired. Sign in again to pair this device.
            </div>
          )}

          {/* Step 1: Login */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>
                1. Account
              </strong>
            </div>
            {accountControls}

            {!accessToken && (
              <>
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      Server: {serverUrl}
                    </span>
                    <button
                      className="btn"
                      disabled={checkingAccount || signingIn}
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
                disabled={pairing || !accessToken || signingOut}
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
              disabled={pairing || !deviceName || !accessToken || signingOut}
            >
              {pairing ? "Pairing..." : "Pair Device"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="field-group">
            <span className="field-group-title">Account</span>
            {accountControls}
            <p className="section-description">
              Signing out of your account keeps this Mac paired for remote access.
              To disconnect it, turn off remote access below.
            </p>
          </div>
          <div className="field-group">
            <span className="field-group-title">Connection</span>

            <div className="form-group">
              <label>This machine</label>
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
              {settings.enabled && !status?.connected && !status?.subscription_required && (
                <div
                  style={{
                    marginTop: 12,
                    background: "var(--warning-bg, rgba(217, 119, 6, 0.12))",
                    border: "1px solid var(--warning-color, #d97706)",
                    borderRadius: 6,
                    padding: "10px 12px",
                    fontSize: 12,
                    color: "var(--warning-color, #d97706)",
                  }}
                >
                  <div style={{ marginBottom: 8 }}>
                    Not connected to the relay. Your phone cannot reach this device.
                  </div>
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
                    {refreshing ? "Reconnecting..." : "Reconnect"}
                  </button>
                </div>
              )}
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
            {accessToken ? <ShareSection
              sharedByMe={shares.shared_by_me}
              sharedWithMe={shares.shared_with_me}
              availableGroups={groups}
              loading={sharesLoading}
              onAdd={handleAddShare}
              onToggleGroup={handleToggleGroup}
              onRemove={(id, shareEmail) => setRemovingShare({ id, email: shareEmail })}
            /> : <p>Sign in to manage sharing.</p>}
          </div>

          <div className="field-group" style={{ borderColor: "var(--danger-color)" }}>
            <span className="field-group-title" style={{ color: "var(--danger-color)" }}>Danger Zone</span>
            <p className="section-description" style={{ marginTop: 0 }}>
              This removes this Mac from your account and disconnects it. You will need to pair again.
            </p>
            {removeError && <p role="alert" className="relay-remove-error">{removeError}</p>}
            {!accessToken && <p>Sign in to remove this Mac from your account.</p>}
            <button className="btn btn-danger" disabled={removingRelay || !accessToken || signingOut} onClick={() => setShowConfirmRemove(true)}>
              Remove Relay Configuration
            </button>

            {showConfirmRemove && (
              <ConfirmDialog
                message="Remove this Mac from your account and disconnect it? You will need to pair again."
                confirmLabel="Remove Mac"
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
