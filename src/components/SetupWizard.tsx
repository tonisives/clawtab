import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ToolInfo } from "../types";
import { ToolGroupList } from "./ToolGroupList";

interface Props {
  onComplete: () => void;
}

type Step = "tools" | "paths" | "terminal" | "editor" | "secrets" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "tools", label: "Detect Tools" },
  { id: "paths", label: "Configure Paths" },
  { id: "terminal", label: "Terminal" },
  { id: "editor", label: "Editor" },
  { id: "secrets", label: "Secrets" },
  { id: "done", label: "Done" },
];

const TERMINAL_OPTIONS = [
  { value: "ghostty", label: "Ghostty" },
  { value: "alacritty", label: "Alacritty" },
  { value: "kitty", label: "Kitty" },
  { value: "wezterm", label: "WezTerm" },
  { value: "iterm", label: "iTerm2" },
  { value: "terminal", label: "Terminal.app" },
];

const EDITOR_OPTIONS: { value: string; label: string; terminal: boolean }[] = [
  { value: "nvim", label: "Neovim", terminal: true },
  { value: "vim", label: "Vim", terminal: true },
  { value: "code", label: "VS Code", terminal: false },
  { value: "codium", label: "VSCodium", terminal: false },
  { value: "zed", label: "Zed", terminal: false },
  { value: "hx", label: "Helix", terminal: true },
  { value: "subl", label: "Sublime Text", terminal: false },
  { value: "emacs", label: "Emacs", terminal: true },
];

export function SetupWizard({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState<Step>("tools");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [tmuxSession, setTmuxSession] = useState("");
  const [preferredTerminal, setPreferredTerminal] = useState("auto");
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const [gopassAvailable, setGopassAvailable] = useState(false);

  const hasTmux = tools.some((t) => t.name === "tmux" && t.available);
  const availableTerminals = TERMINAL_OPTIONS.filter((opt) =>
    tools.some((t) => t.group === "terminal" && t.available && t.name.toLowerCase().startsWith(opt.value)),
  );
  const availableEditors = EDITOR_OPTIONS.filter((opt) =>
    tools.some((t) => t.group === "editor" && t.available && t.name === opt.value),
  );

  const loadTools = async () => {
    const detected = await invoke<ToolInfo[]>("detect_tools");
    setTools(detected);
  };

  // Auto-select best available editor when tools are loaded
  useEffect(() => {
    if (availableEditors.length > 0 && !availableEditors.some((e) => e.value === preferredEditor)) {
      setPreferredEditor(availableEditors[0].value);
    }
  }, [tools]);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setSettings(s);
      setClaudePath(s.claude_path);
      setWorkDir(s.default_work_dir);
      setTmuxSession(s.default_tmux_session);
      setPreferredTerminal(s.preferred_terminal);
      setPreferredEditor(s.preferred_editor);
    });
    loadTools();
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

  const editorLabel = EDITOR_OPTIONS.find((e) => e.value === preferredEditor)?.label ?? preferredEditor;

  const handleFinish = async () => {
    if (!settings) return;
    const updated: AppSettings = {
      ...settings,
      claude_path: claudePath,
      default_work_dir: workDir,
      default_tmux_session: tmuxSession,
      preferred_terminal: hasTmux ? settings.preferred_terminal : preferredTerminal,
      preferred_editor: preferredEditor,
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
            These tools were found on your system. Install any missing required tools before
            proceeding.
          </p>
          <ToolGroupList
            tools={tools}
            onRefresh={loadTools}
            selections={{
              editor: preferredEditor,
              terminal: preferredTerminal === "auto" ? "" : preferredTerminal,
              ai_agent: claudePath,
            }}
            onSelect={(group, toolName) => {
              if (group === "editor") setPreferredEditor(toolName);
              else if (group === "terminal") setPreferredTerminal(toolName);
              else if (group === "ai_agent") setClaudePath(toolName);
            }}
          />
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

      {currentStep === "terminal" && hasTmux && (
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

      {currentStep === "terminal" && !hasTmux && (
        <div>
          <h3>Terminal</h3>
          <p className="section-description">
            tmux was not detected. Choose a terminal to use for running Claude and folder jobs.
          </p>
          <div className="form-group">
            <label>Preferred Terminal</label>
            <select
              value={preferredTerminal}
              onChange={(e) => setPreferredTerminal(e.target.value)}
            >
              <option value="auto">Auto-detect</option>
              {availableTerminals.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="hint">
              Terminal used to launch Claude sessions when tmux is not available
            </span>
          </div>
        </div>
      )}

      {currentStep === "editor" && (
        <div>
          <h3>Editor</h3>
          <p className="section-description">
            Choose an editor for editing job files. Terminal editors open in a popup window,
            GUI editors launch directly.
          </p>
          <div className="form-group">
            <label>Preferred Editor</label>
            <select
              value={preferredEditor}
              onChange={(e) => setPreferredEditor(e.target.value)}
            >
              {availableEditors.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}{e.terminal ? " (terminal)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">
              Used when opening job config files from the Jobs tab
            </span>
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
            {hasTmux ? (
              <p><strong>Tmux Session:</strong> {tmuxSession}</p>
            ) : (
              <p><strong>Terminal:</strong> {preferredTerminal === "auto" ? "Auto-detect" : preferredTerminal}</p>
            )}
            <p><strong>Editor:</strong> {editorLabel}</p>
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
