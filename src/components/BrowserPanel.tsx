import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";

const BROWSER_OPTIONS = [
  { value: "chrome", label: "Chrome", hint: "Uses installed Google Chrome (no download needed)" },
  { value: "brave", label: "Brave", hint: "Uses installed Brave Browser (no download needed)" },
  { value: "chromium", label: "Chromium (bundled)", hint: "Downloads Playwright's bundled Chromium" },
  { value: "firefox", label: "Firefox (bundled)", hint: "Downloads Playwright's bundled Firefox" },
];

export function BrowserPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [playwrightInstalled, setPlaywrightInstalled] = useState<boolean | null>(null);
  const [testLaunching, setTestLaunching] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
    checkPlaywright();
  }, []);

  const checkPlaywright = () => {
    invoke<boolean>("check_playwright_installed")
      .then(setPlaywrightInstalled)
      .catch(() => setPlaywrightInstalled(false));
  };

  const update = async (updates: Partial<AppSettings>) => {
    if (!settings) return;
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    try {
      await invoke("set_settings", { newSettings });
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  const handleTestBrowser = async () => {
    if (!settings) return;
    setTestLaunching(true);
    setTestError(null);
    try {
      await invoke("launch_browser_auth", {
        jobName: "_browser-test",
        url: "https://example.com",
        browser: settings.preferred_browser,
      });
    } catch (e) {
      setTestError(String(e));
    } finally {
      setTestLaunching(false);
      checkPlaywright();
    }
  };

  if (!settings) {
    return <div className="loading">Loading settings...</div>;
  }

  const selectedBrowser = BROWSER_OPTIONS.find((b) => b.value === settings.preferred_browser);

  return (
    <div className="settings-section">
      <h2>Browser</h2>
      <p className="section-description">
        Configure which browser Playwright uses for auth sessions.
        Native browsers (Chrome, Brave) use your installed app and skip large downloads.
      </p>

      <div className="form-group">
        <label>Preferred Browser</label>
        <select
          value={settings.preferred_browser}
          onChange={(e) => update({ preferred_browser: e.target.value })}
        >
          {BROWSER_OPTIONS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        {selectedBrowser && (
          <span className="hint">{selectedBrowser.hint}</span>
        )}
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "24px 0" }} />

      <div className="form-group">
        <label>Status</label>
        <p style={{ fontSize: 13, margin: "4px 0" }}>
          Playwright node module:{" "}
          {playwrightInstalled === null
            ? "checking..."
            : playwrightInstalled
              ? "installed"
              : "not installed"}
        </p>
      </div>

      <div className="form-group">
        <label>Test Browser</label>
        <p className="section-description" style={{ marginBottom: 8 }}>
          Launch a test browser session to verify your setup works.
        </p>
        <button
          className="btn"
          onClick={handleTestBrowser}
          disabled={testLaunching}
        >
          {testLaunching ? "Launching..." : "Test Browser"}
        </button>
        {testLaunching && (
          <p
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginTop: 8,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          >
            Setting up browser... This may take a moment on first run.
          </p>
        )}
        {testError && (
          <p style={{ fontSize: 12, color: "var(--error, #e53e3e)", marginTop: 8 }}>
            {testError}
          </p>
        )}
      </div>
    </div>
  );
}
