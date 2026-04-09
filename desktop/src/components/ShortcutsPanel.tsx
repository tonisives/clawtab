import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  eventToShortcutBinding,
  formatShortcutKeys,
  resolveShortcutSettings,
  type ShortcutId,
} from "../shortcuts";

export function ShortcutsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load shortcuts:", e));
  }, []);

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();

      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }

      if (!settings) return;
      const binding = eventToShortcutBinding(event);
      if (!binding) return;

      const newSettings: AppSettings = {
        ...settings,
        shortcuts: {
          ...resolveShortcutSettings(settings),
          [recordingId]: binding,
        },
      };

      setSettings(newSettings);
      setRecordingId(null);
      invoke("set_settings", { newSettings }).catch((e) => {
        console.error("Failed to save shortcut:", e);
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [recordingId, settings]);

  if (!settings) {
    return <div className="loading">Loading shortcuts...</div>;
  }

  const shortcuts = resolveShortcutSettings(settings);

  const saveShortcuts = (nextShortcuts: AppSettings["shortcuts"]) => {
    const newSettings: AppSettings = {
      ...settings,
      shortcuts: nextShortcuts,
    };
    setSettings(newSettings);
    invoke("set_settings", { newSettings }).catch((e) => {
      console.error("Failed to save shortcuts:", e);
    });
  };

  return (
    <div className="settings-section">
      <h2>Keyboard Shortcuts</h2>
      <div className="field-group">
        <div className="shortcuts-header">
          <span className="field-group-title" style={{ marginBottom: 0, paddingBottom: 0, borderBottom: "none" }}>
            General
          </span>
          <button className="btn btn-sm" onClick={() => saveShortcuts({ ...DEFAULT_SHORTCUTS })}>
            Reset all
          </button>
        </div>
        <p className="section-description shortcuts-description">
          Click Edit, then press the shortcut you want. Press Escape to cancel.
        </p>
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUT_DEFINITIONS.map((shortcut) => (
              <tr key={shortcut.id}>
                <td className="shortcut-label">{shortcut.label}</td>
                <td className="shortcut-keys">
                  {formatShortcutKeys(shortcuts[shortcut.id]).map((key, index) => (
                    <span key={index}>
                      {index > 0 && <span className="shortcut-plus">+</span>}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </td>
                <td className="shortcut-actions">
                  <button className="btn btn-sm" onClick={() => setRecordingId(shortcut.id)}>
                    {recordingId === shortcut.id ? "Press keys..." : "Edit"}
                  </button>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => saveShortcuts({ ...shortcuts, [shortcut.id]: DEFAULT_SHORTCUTS[shortcut.id] })}
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
