import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RunRecord } from "../types";
import { LogViewer } from "./LogViewer";

export function HistoryPanel() {
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<RunRecord | null>(null);

  const loadHistory = async () => {
    try {
      const loaded = await invoke<RunRecord[]>("get_history");
      setRecords(loaded);
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  };

  useEffect(() => {
    loadHistory();
    const interval = setInterval(loadHistory, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleClear = async () => {
    try {
      await invoke("clear_history");
      setRecords([]);
      setSelectedRecord(null);
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  };

  const handleViewDetail = async (id: string) => {
    try {
      const record = await invoke<RunRecord | null>("get_run_detail", { id });
      setSelectedRecord(record ?? null);
    } catch (e) {
      console.error("Failed to load run detail:", e);
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  const exitCodeClass = (code: number | null) => {
    if (code === null) return "running";
    if (code === 0) return "idle";
    return "error";
  };

  const exitCodeLabel = (code: number | null) => {
    if (code === null) return "running";
    if (code === 0) return "ok";
    return `exit ${code}`;
  };

  if (selectedRecord) {
    return (
      <div className="settings-section">
        <div className="section-header">
          <h2>Run Detail</h2>
          <button className="btn btn-sm" onClick={() => setSelectedRecord(null)}>
            Back
          </button>
        </div>
        <table className="data-table" style={{ marginBottom: 16 }}>
          <tbody>
            <tr>
              <td><strong>Job</strong></td>
              <td>{selectedRecord.job_name}</td>
            </tr>
            <tr>
              <td><strong>Trigger</strong></td>
              <td>{selectedRecord.trigger}</td>
            </tr>
            <tr>
              <td><strong>Started</strong></td>
              <td>{formatTime(selectedRecord.started_at)}</td>
            </tr>
            <tr>
              <td><strong>Finished</strong></td>
              <td>
                {selectedRecord.finished_at
                  ? formatTime(selectedRecord.finished_at)
                  : "running..."}
              </td>
            </tr>
            <tr>
              <td><strong>Exit Code</strong></td>
              <td>
                <span className={`status-dot ${exitCodeClass(selectedRecord.exit_code)}`} />
                {exitCodeLabel(selectedRecord.exit_code)}
              </td>
            </tr>
          </tbody>
        </table>

        {selectedRecord.stdout && (
          <>
            <h3>stdout</h3>
            <LogViewer content={selectedRecord.stdout} />
          </>
        )}
        {selectedRecord.stderr && (
          <>
            <h3 style={{ marginTop: 12 }}>stderr</h3>
            <LogViewer content={selectedRecord.stderr} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>History</h2>
        {records.length > 0 && (
          <button className="btn btn-danger btn-sm" onClick={handleClear}>
            Clear
          </button>
        )}
      </div>

      {records.length === 0 ? (
        <div className="empty-state">
          <p>No run history yet.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Job</th>
              <th>Trigger</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => {
              const duration =
                r.finished_at
                  ? `${((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
                  : "...";

              return (
                <tr key={r.id}>
                  <td>
                    <span className={`status-dot ${exitCodeClass(r.exit_code)}`} />
                    {exitCodeLabel(r.exit_code)}
                  </td>
                  <td>{r.job_name}</td>
                  <td>{r.trigger}</td>
                  <td>{formatTime(r.started_at)}</td>
                  <td>{duration}</td>
                  <td className="actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => handleViewDetail(r.id)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
