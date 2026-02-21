import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ToolInfo } from "../types";
import { ToolGroupList } from "./ToolGroupList";

export function ToolsPanel() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);

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
    invoke<AppSettings>("get_settings").then(setSettings);
  }, []);

  const selections: Record<string, string> = settings
    ? {
        editor: settings.preferred_editor,
        terminal: settings.preferred_terminal === "auto" ? "" : settings.preferred_terminal,
      }
    : {};

  const handleSelect = async (group: string, toolName: string) => {
    if (!settings) return;
    let updates: Partial<AppSettings> = {};
    if (group === "editor") {
      updates = { preferred_editor: toolName };
    } else if (group === "terminal") {
      updates = { preferred_terminal: toolName };
    }
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    try {
      await invoke("set_settings", { newSettings });
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

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
        <ToolGroupList
          tools={tools}
          onRefresh={loadTools}
          showPath
          selections={selections}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
}
