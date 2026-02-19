import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ToolInfo } from "../types";

interface Props {
  onComplete: () => void;
}

type Step = "tools" | "paths" | "tmux" | "secrets" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "tools", label: "Detect Tools" },
  { id: "paths", label: "Configure Paths" },
  { id: "tmux", label: "Tmux Session" },
  { id: "secrets", label: "Secrets" },
  { id: "done", label: "Done" },
];

export function SetupWizard({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState<Step>("tools");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [tmuxSession, setTmuxSession] = useState("");
  const [gopassAvailable, setGopassAvailable] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setSettings(s);
      setClaudePath(s.claude_path);
      setWorkDir(s.default_work_dir);
      setTmuxSession(s.default_tmux_session);
    });
    invoke<ToolInfo[]>("detect_tools").then(setTools);
    invoke<boolean>("gopass_available").then(setGopassAvailable);
  }, []);

  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  const goNext = () => {
    if (currentIdx < STEPS.length - 1) {
      setCurrentStep(STEPS[currentIdx + 1].id);
    }
  };

  const goBack = () => {
    if (currentIdx > 0) {
      setCurrentStep(STEPS[currentIdx - 1].id);
    }
  };

  const handleFinish = async () => {
    if (!settings) return;
    const updated: AppSettings = {
      ...settings,
      claude_path: claudePath,
      default_work_dir: workDir,
      default_tmux_session: tmuxSession,
      setup_completed: true,
    };
    try {
      await invoke("set_settings", { newSettings: updated });
      onComplete();
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  return (
    <div className="settings-section" style={{ maxWidth: 600, margin: "0 auto" }}>
      <h2>ClawdTab Setup</h2>

      <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
        {STEPS.map((step, idx) => (
          <div
            key={step.id}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: idx <= currentIdx ? "var(--accent)" : "var(--border)",
            }}
          />
        ))}
      </div>

      <p className="text-secondary" style={{ marginBottom: 16 }}>
        Step {currentIdx + 1} of {STEPS.length}: {STEPS[currentIdx].label}
      </p>

      {currentStep === "tools" && (
        <div>
          <h3>Detected Tools</h3>
          <p className="section-description">
            These tools were found on your system. Install any missing tools before proceeding.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name}>
                  <td>{tool.name}</td>
                  <td>
                    {tool.available ? (
                      <span className="status-badge status-success">found</span>
                    ) : (
                      <span className="status-badge status-failed">missing</span>
                    )}
                  </td>
                  <td className="text-secondary">{tool.version ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {currentStep === "paths" && (
        <div>
          <h3>Configure Paths</h3>
          <div className="form-group">
            <label>Claude CLI Path</label>
            <input
              type="text"
              value={claudePath}
              onChange={(e) => setClaudePath(e.target.value)}
              placeholder="claude"
            />
            <span className="hint">Path to the Claude CLI binary</span>
          </div>
          <div className="form-group">
            <label>Default Working Directory</label>
            <input
              type="text"
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="~/workspace"
              style={{ maxWidth: "100%" }}
            />
            <span className="hint">Default directory for running jobs</span>
          </div>
        </div>
      )}

      {currentStep === "tmux" && (
        <div>
          <h3>Tmux Session</h3>
          <p className="section-description">
            Claude and folder jobs run inside tmux windows. Choose a default session name.
          </p>
          <div className="form-group">
            <label>Default Tmux Session</label>
            <input
              type="text"
              value={tmuxSession}
              onChange={(e) => setTmuxSession(e.target.value)}
              placeholder="tgs"
            />
          </div>
        </div>
      )}

      {currentStep === "secrets" && (
        <div>
          <h3>Secrets</h3>
          <p className="section-description">
            Secrets are stored in macOS Keychain and injected as environment variables into jobs.
            {gopassAvailable
              ? " gopass is available on your system. You can import secrets from gopass in the Secrets tab."
              : " gopass was not detected. You can add secrets manually in the Secrets tab."}
          </p>
          <p>You can configure secrets after setup in the Secrets tab.</p>
        </div>
      )}

      {currentStep === "done" && (
        <div>
          <h3>Setup Complete</h3>
          <p className="section-description">
            ClawdTab is ready to use. You can create your first job from the Jobs tab,
            or re-run this wizard from Settings.
          </p>
          <div style={{ marginTop: 12 }}>
            <p><strong>Claude Path:</strong> {claudePath}</p>
            <p><strong>Work Dir:</strong> {workDir}</p>
            <p><strong>Tmux Session:</strong> {tmuxSession}</p>
          </div>
        </div>
      )}

      <div className="btn-group" style={{ marginTop: 24 }}>
        {currentIdx > 0 && (
          <button className="btn" onClick={goBack}>
            Back
          </button>
        )}
        {currentStep === "done" ? (
          <button className="btn btn-primary" onClick={handleFinish}>
            Finish Setup
          </button>
        ) : (
          <button className="btn btn-primary" onClick={goNext}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
