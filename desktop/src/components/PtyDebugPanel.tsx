import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XtermPane } from "./XtermPane";

interface FreePaneInfo {
  pane_id: string;
  session: string;
  window_index: string;
  window_name: string;
  width: number;
  height: number;
  command: string;
}

interface CapturedPaneInfo {
  pane_id: string;
  capture_session: string;
  window_id: string;
  window_name: string;
  origin_session: string;
  origin_window_name: string;
  command: string;
  width: number;
  height: number;
}

interface SlotSelection {
  paneId: string;
  tmuxSession: string;
}

const SLOT_COUNT = 2;

function slotGroup(slotIndex: number): string {
  return `debug-slot-${slotIndex}`;
}

export function PtyDebugPanel() {
  const [freePanes, setFreePanes] = useState<FreePaneInfo[]>([]);
  const [captured, setCaptured] = useState<CapturedPaneInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<(SlotSelection | null)[]>(
    () => new Array(SLOT_COUNT).fill(null),
  );

  const refresh = useCallback(async () => {
    try {
      const [free, cap] = await Promise.all([
        invoke<FreePaneInfo[]>("list_free_panes"),
        invoke<CapturedPaneInfo[]>("list_captured_panes"),
      ]);
      setFreePanes(free);
      setCaptured(cap);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleSelect = useCallback(
    (slotIndex: number, value: string) => {
      if (!value) {
        setSelections((prev) => {
          const next = [...prev];
          next[slotIndex] = null;
          return next;
        });
        return;
      }
      const [paneId, tmuxSession] = value.split("|");
      if (!paneId || !tmuxSession) return;
      setSelections((prev) => {
        const next = [...prev];
        next[slotIndex] = { paneId, tmuxSession };
        return next;
      });
    },
    [],
  );

  const handleRelease = useCallback(
    async (paneId: string) => {
      try {
        await invoke("pty_release", { paneId });
        setSelections((prev) =>
          prev.map((sel) => (sel?.paneId === paneId ? null : sel)),
        );
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const handleStop = useCallback((slotIndex: number) => {
    setSelections((prev) => {
      const next = [...prev];
      next[slotIndex] = null;
      return next;
    });
  }, []);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "#1c1c1e",
        color: "#e4e4e4",
      }}
    >
      <Toolbar
        freeCount={freePanes.length}
        capturedCount={captured.length}
        error={error}
        onRefresh={refresh}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {selections.map((sel, idx) => (
          <Slot
            key={idx}
            slotIndex={idx}
            selection={sel}
            freePanes={freePanes}
            captured={captured}
            onSelect={(value) => handleSelect(idx, value)}
            onRelease={handleRelease}
            onStop={() => handleStop(idx)}
          />
        ))}
      </div>
    </div>
  );
}

interface ToolbarProps {
  freeCount: number;
  capturedCount: number;
  error: string | null;
  onRefresh: () => void;
}

function Toolbar({ freeCount, capturedCount, error, onRefresh }: ToolbarProps) {
  return (
    <div
      style={{
        flexShrink: 0,
        padding: "6px 10px",
        background: "#2a2a2c",
        borderBottom: "1px solid #444",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
      }}
    >
      <button onClick={onRefresh} style={buttonStyle}>
        Refresh
      </button>
      <span style={{ color: "#aaa" }}>
        {freeCount} free, {capturedCount} captured
      </span>
      {error && (
        <span style={{ color: "#ff6b6b", marginLeft: 8 }}>{error}</span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ color: "#666", fontSize: 11 }}>
        uses real pty_spawn / XtermPane
      </span>
    </div>
  );
}

interface SlotProps {
  slotIndex: number;
  selection: SlotSelection | null;
  freePanes: FreePaneInfo[];
  captured: CapturedPaneInfo[];
  onSelect: (value: string) => void;
  onRelease: (paneId: string) => void;
  onStop: () => void;
}

function Slot({
  slotIndex,
  selection,
  freePanes,
  captured,
  onSelect,
  onRelease,
  onStop,
}: SlotProps) {
  const currentValue = useMemo(() => {
    if (!selection) return "";
    return `${selection.paneId}|${selection.tmuxSession}`;
  }, [selection]);

  const capturedBySameSlot = useMemo(
    () => captured.filter((c) => c.capture_session === `clawtab-${slotGroup(slotIndex)}`),
    [captured, slotIndex],
  );

  const capturedElsewhere = useMemo(
    () => captured.filter((c) => c.capture_session !== `clawtab-${slotGroup(slotIndex)}`),
    [captured, slotIndex],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid #444",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "4px 8px",
          background: "#232325",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
        }}
      >
        <span style={{ color: "#888", width: 50 }}>slot {slotIndex}</span>
        <select
          value={currentValue}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            background: "#333",
            color: "#e4e4e4",
            border: "1px solid #555",
            padding: "3px 6px",
            borderRadius: 4,
            fontSize: 12,
            minWidth: 320,
            maxWidth: 500,
          }}
        >
          <option value="">-- select pane --</option>
          {capturedBySameSlot.length > 0 && (
            <optgroup label="Captured (this slot)">
              {capturedBySameSlot.map((c) => (
                <option
                  key={c.pane_id}
                  value={`${c.pane_id}|${c.capture_session}`}
                >
                  {c.pane_id} {c.window_name} {c.width}x{c.height} [{c.command}]
                  {c.origin_session &&
                    ` <- ${c.origin_session}:${c.origin_window_name}`}
                </option>
              ))}
            </optgroup>
          )}
          {capturedElsewhere.length > 0 && (
            <optgroup label="Captured (other slots)">
              {capturedElsewhere.map((c) => (
                <option
                  key={c.pane_id}
                  value={`${c.pane_id}|${c.capture_session}`}
                >
                  {c.pane_id} {c.window_name} {c.capture_session}{" "}
                  {c.width}x{c.height} [{c.command}]
                </option>
              ))}
            </optgroup>
          )}
          {freePanes.length > 0 && (
            <optgroup label="Free panes">
              {freePanes.map((p) => (
                <option key={p.pane_id} value={`${p.pane_id}|${p.session}`}>
                  {p.pane_id} {p.session}:{p.window_index}:{p.window_name}{" "}
                  {p.width}x{p.height} [{p.command}]
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button onClick={onStop} disabled={!selection} style={buttonStyle}>
          Stop
        </button>
        <button
          onClick={() => selection && onRelease(selection.paneId)}
          disabled={!selection}
          style={buttonStyle}
        >
          Release
        </button>
        {selection && (
          <span style={{ color: "#888", marginLeft: 8 }}>
            {selection.paneId} @ {selection.tmuxSession}
          </span>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "#1c1c1e",
        }}
      >
        {selection ? (
          <XtermPane
            key={`${slotIndex}:${selection.paneId}`}
            paneId={selection.paneId}
            tmuxSession={selection.tmuxSession}
            group={slotGroup(slotIndex)}
            onExit={() => onStop()}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#555",
              fontSize: 12,
            }}
          >
            no pane selected
          </div>
        )}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "#444",
  color: "#e4e4e4",
  border: "1px solid #555",
  padding: "4px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};
