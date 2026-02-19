import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "../types";

export function ToolsPanel() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTools = async () => {
    setLoading(true);
    try {
      const detected = await invoke<ToolInfo[]>("detect_tools");
      setTools(detected);
    } catch (e) {
      console.error("Failed to detect tools:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadTools();
  }, []);

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Tools</h2>
        <button
          className="btn btn-sm"
          onClick={loadTools}
          disabled={loading}
        >
          {loading ? "Scanning..." : "Rescan"}
        </button>
      </div>

      {loading && tools.length === 0 ? (
        <div className="empty-state">
          <p>Scanning for tools...</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Tool</th>
              <th>Version</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <span
                    className={`status-dot ${tool.available ? "running" : "error"}`}
                  />
                </td>
                <td>{tool.name}</td>
                <td>
                  {tool.version ? (
                    <code>{tool.version}</code>
                  ) : (
                    <span className="text-secondary">--</span>
                  )}
                </td>
                <td>
                  {tool.path ? (
                    <code>{tool.path}</code>
                  ) : (
                    <span className="text-secondary">not found</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
