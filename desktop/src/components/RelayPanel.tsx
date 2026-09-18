import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktopMachineApi, resetDesktopAccount } from "../machines/connection";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShareSection } from "@clawtab/shared";
import type { ShareInfo, SharedWithMeInfo } from "@clawtab/shared";
import { pollRelayLogin, startRelayLogin } from "../relayLogin";
import { acceptRemoteSignIn, beginRemoteSignIn, checkRemoteConnection, connectRemoteConnection, disconnectRemoteConnection, retryRemoteConnection, useRemoteConnection } from "../machines/remoteConnection";
import { RemoteConnectionStatus } from "./RemoteConnectionStatus";

interface RelaySettings {
  enabled: boolean;
  server_url: string;
  device_token: string;
  device_id: string;
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
  let remote = useRemoteConnection();
  let accessToken = remote.token;
  let checkingAccount = remote.account === "checking" && !remote.error;
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
  let [signingOut, setSigningOut] = useState(false);
  let accountVersion = useRef(0);
  let signingOutRef = useRef(false);
  let ignoreCallbacks = useRef(false);
  let loginAttempt = useRef<AbortController | null>(null);
  const [editingServerUrl, setEditingServerUrl] = useState(false);
  const [tempServerUrl, setTempServerUrl] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  // Sharing state
  const [shares, setShares] = useState<SharesResponse>({ shared_by_me: [], shared_with_me: [] });
  const [sharesLoading, setSharesLoading] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [removingShare, setRemovingShare] = useState<{ id: string; email: string } | null>(null);

  useEffect(() => {
    if (remote.account === "checking") void checkRemoteConnection();
  }, [remote.account]);

  useEffect(() => {
    Promise.all([
      invoke<RelaySettings | null>("get_relay_settings"),
      invoke<string>("get_hostname"),
    ]).then(([s, hostname]) => {
      setSettings(s);
      if (s) {
        setServerUrl(s.server_url || "https://relay.clawtab.cc");
        setDeviceName(s.device_name || "");
      } else {
        setDeviceName(hostname || "");
      }
      setLoaded(true);
    });
  }, []);

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
        }).then(async () => {
          if (version !== accountVersion.current) return;
          await acceptRemoteSignIn(externalAccessToken);
          setLoginError(null);
          setSigningIn(false);
          setLoginStatus("Signed in to your account.");
        }).catch(() => {
          if (version !== accountVersion.current) return;
          setSigningIn(false);
          setLoginStatus("");
          setLoginError("Could not save your account session. Please try signing in again.");
        });
      }
      onExternalTokenConsumed?.();
    }
  }, [externalAccessToken]);

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
    beginRemoteSignIn();
    ignoreCallbacks.current = false;
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
          await acceptRemoteSignIn(tokens.access_token);
          setLoginStatus("Signed in to your account.");
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
    beginRemoteSignIn();
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
      await connectRemoteConnection();
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith(UNAUTHORIZED_PREFIX)) {
        await disconnectRemoteConnection().catch(() => {});
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
      await disconnectRemoteConnection();
      setLoginStatus("");
      setSigningIn(false);
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
      await checkRemoteConnection();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Could not remove this machine. Please retry.");
    } finally {
      setRemovingRelay(false);
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
        {signingIn && !accessToken
          ? loginStatus
          : checkingAccount
            ? "Checking your account…"
            : remote.account === "unavailable"
              ? "Could not check your account."
              : accessToken
              ? "Signed in to your account."
              : "Sign in to connect."}
      </p>
      {loginError && <p role="alert">{loginError}</p>}
      {remote.error && <p role="alert">{remote.error}</p>}
      <div className="btn-group">
        {remote.error && <button className="btn" onClick={() => void retryRemoteConnection()}>Retry account check</button>}
        {accessToken ? (
          <button className="btn" onClick={handleSignOut} disabled={signingOut || pairing || !!remote.operation}>
            {signingOut ? "Disconnecting…" : "Sign out"}
          </button>
        ) : signingIn ? (
          <button className="btn" onClick={cancelSignIn}>Cancel sign-in</button>
        ) : (
          <>
            <button className="btn" onClick={handleAppleSignIn} disabled={checkingAccount}>Sign in with Apple</button>
            <button className="btn" onClick={handleGoogleSignIn} disabled={checkingAccount}>Sign in with Google</button>
          </>
        )}
      </div>
    </>
  );

  let connectionControls = (
    <>
      <RemoteConnectionStatus label={remote.label} phase={remote.phase} />
      <div className="btn-group">
        {remote.phase === "subscription" && <button className="btn btn-primary" onClick={async () => {
          try {
            let response = await fetch("https://backend.clawtab.cc/subscription/payment-link");
            let { url } = await response.json();
            await openUrl(url);
          } catch {
            await openUrl("https://buy.stripe.com/14AdRaemTbqlaF2bUL0Jq01");
          }
        }}>Subscribe</button>}
        {accessToken && remote.phase !== "connected" && <button className="btn btn-primary" onClick={connectRemoteConnection} disabled={!!remote.operation}>
          {remote.operation === "connect" ? "Connecting…" : "Connect"}
        </button>}
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
            <p className="section-description">Signing out disconnects ClawTab from remote access.</p>
          </div>
          <div className="field-group">
            <span className="field-group-title">This Mac</span>

            <div className="form-group">
              <label>Relay</label>
              {connectionControls}
            </div>

            <div className="form-group">
              <label>Relay server</label>
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
