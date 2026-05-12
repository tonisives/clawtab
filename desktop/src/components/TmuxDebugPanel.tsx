import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface TmuxDebugWindow {
  session: string;
  index: number;
  name: string;
  window_id: string;
  active: boolean;
  pane_count: number;
  active_pane_id: string;
  active_command: string;
  clawtab_origin: string;
}

interface TmuxDebugSnapshot {
  sessions: string[];
  windows: TmuxDebugWindow[];
}

interface TmuxMoveResult {
  moved: string[];
  skipped: string[];
}

const POLL_MS = 3000;

export function TmuxDebugPanel() {
  const [snapshot, setSnapshot] = useState<TmuxDebugSnapshot>({ sessions: [], windows: [] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetSession, setTargetSession] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<TmuxDebugSnapshot>("list_tmux_debug_windows");
      setSnapshot(next);
      setTargetSession((current) => current || next.sessions[0] || "");
      setSelected((prev) => {
        const live = new Set(next.windows.map((w) => w.window_id));
        return new Set([...prev].filter((id) => live.has(id)));
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const selectedRows = useMemo(
    () => snapshot.windows.filter((window) => selected.has(window.window_id)),
    [snapshot.windows, selected],
  );

  const selectedBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const window of selectedRows) {
      counts.set(window.session, (counts.get(window.session) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [selectedRows]);

  const toggleWindow = useCallback((windowId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(windowId)) next.delete(windowId);
      else next.add(windowId);
      return next;
    });
  }, []);

  const selectSession = useCallback((session: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = snapshot.windows.filter((w) => w.session === session).map((w) => w.window_id);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [snapshot.windows]);

  const handleMove = useCallback(async () => {
    if (!targetSession || selected.size === 0) return;
    setMoving(true);
    setMessage(null);
    try {
      const result = await invoke<TmuxMoveResult>("move_tmux_windows_to_session", {
        windowIds: [...selected],
        targetSession,
      });
      setMessage([
        result.moved.length > 0 ? `Moved ${result.moved.length} window${result.moved.length === 1 ? "" : "s"}.` : "No windows moved.",
        result.skipped.length > 0 ? `Skipped: ${result.skipped.join(", ")}` : "",
      ].filter(Boolean).join(" "));
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setMoving(false);
    }
  }, [refresh, selected, targetSession]);

  const grouped = useMemo(() => {
    const groups = new Map<string, TmuxDebugWindow[]>();
    for (const window of snapshot.windows) {
      const list = groups.get(window.session) ?? [];
      list.push(window);
      groups.set(window.session, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot.windows]);

  return (
    <div style={rootStyle}>
      <header style={headerStyle}>
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Tmux Debug</h1>
        <button onClick={refresh} style={buttonStyle}>Refresh</button>
        <span style={{ color: "#64748b" }}>
          {snapshot.sessions.length} sessions, {snapshot.windows.length} windows
        </span>
        <span style={{ flex: 1 }} />
        <select value={targetSession} onChange={(e) => setTargetSession(e.target.value)} style={selectStyle}>
          {snapshot.sessions.map((session) => (
            <option key={session} value={session}>{session}</option>
          ))}
        </select>
        <button
          onClick={handleMove}
          disabled={moving || selected.size === 0 || !targetSession}
          style={{ ...buttonStyle, opacity: moving || selected.size === 0 || !targetSession ? 0.5 : 1 }}
        >
          Move selected
        </button>
      </header>

      {(error || message || selected.size > 0) && (
        <div style={statusStyle}>
          {selected.size > 0 && (
            <span>
              {selected.size} selected
              {selectedBySession.length > 0 && ` from ${selectedBySession.map(([s, n]) => `${s} (${n})`).join(", ")}`}
            </span>
          )}
          {message && <span style={{ color: "#166534" }}>{message}</span>}
          {error && <span style={{ color: "#dc2626" }}>{error}</span>}
        </div>
      )}

      <div style={contentStyle}>
        {grouped.length === 0 ? (
          <div style={emptyStyle}>No tmux windows found.</div>
        ) : (
          grouped.map(([session, windows]) => (
            <section key={session} style={cardStyle}>
              <div style={sessionHeaderStyle}>
                <button onClick={() => selectSession(session)} style={buttonStyle}>Select session</button>
                <strong>{session}</strong>
                <span style={{ color: "#64748b" }}>{windows.length} windows</span>
              </div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <Th />
                    <Th>Index</Th>
                    <Th>Window</Th>
                    <Th>Pane</Th>
                    <Th>Panes</Th>
                    <Th>Command</Th>
                    <Th>Origin</Th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((window) => (
                    <tr key={`${window.session}:${window.window_id}`} style={window.active ? activeRowStyle : undefined}>
                      <Td>
                        <input
                          type="checkbox"
                          checked={selected.has(window.window_id)}
                          onChange={() => toggleWindow(window.window_id)}
                        />
                      </Td>
                      <Td mono>{window.index}</Td>
                      <Td>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={monoStyle}>{window.window_id}</span>
                          <span>{window.name}</span>
                        </div>
                      </Td>
                      <Td mono>{window.active_pane_id}</Td>
                      <Td mono>{window.pane_count}</Td>
                      <Td>{window.active_command}</Td>
                      <Td title={window.clawtab_origin} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {window.clawtab_origin || "-"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  background: "#f8fafc",
  color: "#0f172a",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 12,
};

const headerStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  background: "#fff",
  borderBottom: "1px solid #e2e8f0",
};

const statusStyle: React.CSSProperties = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  padding: "8px 14px",
  borderBottom: "1px solid #e2e8f0",
  background: "#f1f5f9",
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
};

const sessionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderBottom: "1px solid #e2e8f0",
  background: "#f8fafc",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const activeRowStyle: React.CSSProperties = {
  background: "#f0f9ff",
};

const emptyStyle: React.CSSProperties = {
  margin: "auto",
  color: "#64748b",
};

const buttonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 10px",
  borderRadius: 4,
  border: "1px solid #cbd5e1",
  background: "#fff",
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid #cbd5e1",
  background: "#fff",
  minWidth: 180,
};

const monoStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
};

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #e2e8f0", color: "#475569", fontWeight: 600 }}>
      {children}
    </th>
  );
}

function Td({ children, mono, style, title }: { children: React.ReactNode; mono?: boolean; style?: React.CSSProperties; title?: string }) {
  return (
    <td title={title} style={{ padding: "6px 8px", borderBottom: "1px solid #f1f5f9", verticalAlign: "middle", ...(mono ? monoStyle : null), ...style }}>
      {children}
    </td>
  );
}
