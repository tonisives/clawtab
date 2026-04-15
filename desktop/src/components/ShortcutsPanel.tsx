import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  eventToShortcutBinding,
  formatShortcutSteps,
  resolveShortcutSettings,
  type ShortcutId,
} from "../shortcuts";

export function ShortcutsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recording, setRecording] = useState<{ id: ShortcutId; strokes: string[] } | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load shortcuts:", e));
  }, []);

  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      event.preventDefault();

      if (event.key === "Escape") {
        setRecording(null);
        return;
      }

      if (!settings) return;
      const currentShortcuts = resolveShortcutSettings(settings);
      if (event.key === "Enter" && recording.strokes.length === 1) {
        if (recording.id === "prefix_key") {
          const newSettings: AppSettings = {
            ...settings,
            shortcuts: {
              ...currentShortcuts,
              prefix_key: recording.strokes[0],
            },
          };

          setSettings(newSettings);
          setRecording(null);
          invoke("set_settings", { newSettings }).catch((e) => {
            console.error("Failed to save shortcut:", e);
          });
          return;
        }

        const newSettings: AppSettings = {
          ...settings,
          shortcuts: {
            ...currentShortcuts,
            [recording.id]: recording.strokes[0],
          },
        };

        setSettings(newSettings);
        setRecording(null);
        invoke("set_settings", { newSettings }).catch((e) => {
          console.error("Failed to save shortcut:", e);
        });
        return;
      }

      const binding = eventToShortcutBinding(event);
      if (!binding) return;

      if (recording.id === "prefix_key") {
        const newSettings: AppSettings = {
          ...settings,
          shortcuts: {
            ...currentShortcuts,
            prefix_key: binding,
          },
        };

        setSettings(newSettings);
        setRecording(null);
        invoke("set_settings", { newSettings }).catch((e) => {
          console.error("Failed to save shortcut:", e);
        });
        return;
      }

      const nextStrokes = [...recording.strokes, binding].slice(0, 2);
      if (nextStrokes.length < 2) {
        setRecording({ ...recording, strokes: nextStrokes });
        return;
      }

      const resolvedBinding = nextStrokes[0] === currentShortcuts.prefix_key
        ? `Prefix ${nextStrokes[1]}`
        : nextStrokes.join(" ");

      const newSettings: AppSettings = {
        ...settings,
        shortcuts: {
          ...currentShortcuts,
          [recording.id]: resolvedBinding,
        },
      };

      setSettings(newSettings);
      setRecording(null);
      invoke("set_settings", { newSettings }).catch((e) => {
        console.error("Failed to save shortcut:", e);
      });
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [recording, settings]);

  useEffect(() => {
    const handleFind = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleFind);
    return () => document.removeEventListener("keydown", handleFind);
  }, []);

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

  const saveShortcut = (id: ShortcutId, binding: string) => {
    saveShortcuts({
      ...shortcuts,
      [id]: binding,
    });
  };

  const getDisplayBinding = (id: ShortcutId): string => {
    if (recording?.id !== id || recording.strokes.length === 0) return shortcuts[id];
    if (id === "prefix_key") return recording.strokes[0];
    if (recording.strokes[0] === shortcuts.prefix_key) {
      return recording.strokes.length === 1
        ? "Prefix"
        : `Prefix ${recording.strokes[1]}`;
    }
    return recording.strokes.join(" ");
  };

  const query = search.toLowerCase();
  const filtered = query
    ? SHORTCUT_DEFINITIONS.filter((s) => {
        const binding = shortcuts[s.id];
        return (
          s.label.toLowerCase().includes(query) ||
          s.id.toLowerCase().includes(query) ||
          binding.toLowerCase().includes(query)
        );
      })
    : SHORTCUT_DEFINITIONS;

  return (
    <div className="settings-section">
      <h2>Keyboard Shortcuts</h2>
      <div className="field-group">
        <div className="shortcuts-search-bar">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search shortcuts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="shortcuts-search-input"
          />
        </div>
        <div className="shortcuts-header">
          <span className="field-group-title" style={{ marginBottom: 0, paddingBottom: 0, borderBottom: "none" }}>
            General
          </span>
          <button className="btn btn-sm" onClick={() => saveShortcuts({ ...DEFAULT_SHORTCUTS })}>
            Reset all
          </button>
        </div>
        <p className="section-description shortcuts-description">
          {recording
            ? recording.id === "prefix_key"
              ? "Press the key you want to use as the tmux-style prefix. Press Escape to cancel."
              : recording.strokes.length === 0
                ? "Press the first key. If it matches the prefix key, the shortcut will be saved as Prefix plus the second key. Enter saves a single keystroke. Escape cancels."
                : "Press the second key for the sequence, Enter to save the first key as-is, or Escape to cancel."
            : "Click Edit, then press the shortcut you want. Two-keystroke bindings and Prefix-based shortcuts are supported. Press Escape to cancel."}
        </p>
        <table className="shortcuts-table">
          <tbody>
            {filtered.map((shortcut) => (
              <tr key={shortcut.id}>
                <td className="shortcut-label">{shortcut.label}</td>
                <td className="shortcut-keys">
                  {formatShortcutSteps(getDisplayBinding(shortcut.id)).map((step, stepIndex) => (
                    <span key={stepIndex}>
                      {stepIndex > 0 && <span className="shortcut-plus" style={{ margin: "0 10px" }}>then</span>}
                      {step.map((key, keyIndex) => (
                        <span key={`${stepIndex}-${keyIndex}`}>
                          {keyIndex > 0 && <span className="shortcut-plus">+</span>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </td>
                <td className="shortcut-actions">
                  <button
                    className="btn btn-sm"
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setRecording({ id: shortcut.id, strokes: [] });
                    }}
                  >
                    {recording?.id === shortcut.id ? "Recording..." : "Edit"}
                  </button>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => saveShortcut(shortcut.id, DEFAULT_SHORTCUTS[shortcut.id])}
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
