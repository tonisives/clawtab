import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DaemonStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  ui_only_mode: boolean;
}

export function DaemonPanel() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [showLogs, setShowLogs] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsRef = useRef<HTMLPreElement>(null);

  const fetchStatus = () => {
    invoke<DaemonStatus>("get_daemon_status")
      .then(setStatus)
      .catch((e) => console.error("Failed to get daemon status:", e));
  };

  const fetchLogs = useCallback(() => {
    invoke<string>("get_daemon_logs", { lines: 200 })
      .then(setLogs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(() => {
      fetchStatus();
      if (showLogs) fetchLogs();
    }, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [showLogs, fetchLogs]);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  const handleToggle = async (enable: boolean) => {
    setLoading(true);
    setError(null);
    try {
      if (enable) {
        await invoke<string>("daemon_install");
      } else {
        await invoke<string>("daemon_uninstall");
      }
      fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setError(null);
    try {
      await invoke<string>("daemon_restart");
      fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setRestarting(false);
    }
  };

  if (!status) {
    return (
      <div className="settings-section">
        <h2>Daemon</h2>
        <div className="loading">Loading...</div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2>Daemon</h2>
      <p className="section-description">
        The daemon runs background tasks (scheduler, auto-yes, relay) independently of the desktop
        app. When enabled, closing the app won't stop your jobs.
      </p>

      <div className="field-group">
        <span className="field-group-title">Status</span>
        <div className="form-group">
          <label>Service</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
              {status.running
                ? `Running (pid ${status.pid})`
                : status.installed
                  ? "Installed but not running"
                  : "Not installed"}
            </span>
            {status.installed && (
              <button
                className="btn btn-sm"
                disabled={restarting}
                onClick={handleRestart}
              >
                {restarting ? "Restarting..." : "Restart"}
              </button>
            )}
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Desktop app mode</label>
          <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
            {status.ui_only_mode
              ? "UI only - daemon handles background tasks"
              : "Standalone - app handles all tasks"}
          </span>
          {status.ui_only_mode && (
            <span className="hint">Restart the app after changing daemon state</span>
          )}
          {!status.ui_only_mode && status.running && (
            <span className="hint">Restart the app to switch to UI-only mode</span>
          )}
        </div>
      </div>

      <div className="field-group">
        <span className="field-group-title">Enable</span>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={status.installed}
              disabled={loading}
              onChange={(e) => handleToggle(e.target.checked)}
            />
            {loading ? "Updating..." : "Install daemon as login service"}
          </label>
          <span className="hint">
            Registers a launchd service that starts automatically on login
          </span>
        </div>
      </div>

      {error && (
        <div className="field-group" style={{ borderColor: "var(--danger-color)" }}>
          <span className="field-group-title" style={{ color: "var(--danger-color)" }}>Error</span>
          <p style={{ fontSize: 13, color: "var(--danger-color)", margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="field-group">
        <span className="field-group-title">Logs</span>
        <div className="form-group" style={{ marginBottom: showLogs ? 8 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="btn"
              onClick={() => {
                if (!showLogs) fetchLogs();
                setShowLogs(!showLogs);
              }}
            >
              {showLogs ? "Hide Logs" : "Show Logs"}
            </button>
            {showLogs && (
              <button className="btn btn-sm" onClick={fetchLogs}>
                Refresh
              </button>
            )}
          </div>
          <span className="hint">/tmp/clawtab/daemon.stderr.log</span>
        </div>
        {showLogs && (
          <pre
            ref={logsRef}
            style={{
              fontSize: 11,
              lineHeight: 1.4,
              margin: 0,
              padding: 8,
              background: "var(--bg-secondary)",
              borderRadius: 4,
              maxHeight: 400,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--text-secondary)",
            }}
          >
            {logs || "No logs found"}
          </pre>
        )}
      </div>
    </div>
  );
}
