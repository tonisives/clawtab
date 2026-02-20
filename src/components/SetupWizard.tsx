import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, Job, TelegramConfig, ToolInfo } from "../types";
import { ToolGroupList } from "./ToolGroupList";
import { TelegramSetup } from "./TelegramSetup";

interface Props {
  onComplete: () => void;
}

type Step = "tools" | "tmux" | "editor" | "secrets" | "telegram" | "first-job" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "tools", label: "Detect Tools" },
  { id: "tmux", label: "Tmux" },
  { id: "editor", label: "Editor" },
  { id: "secrets", label: "Secrets" },
  { id: "telegram", label: "Telegram" },
  { id: "first-job", label: "Test Job" },
  { id: "done", label: "Done" },
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
  const [telegramConfig, setTelegramConfig] = useState<TelegramConfig | null>(null);
  const [telegramLoaded, setTelegramLoaded] = useState(false);
  const [telegramSkipped, setTelegramSkipped] = useState(false);
  const [notifySuccess, setNotifySuccess] = useState(true);
  const [notifyFailure, setNotifyFailure] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(true);

  // First-job step state
  const [testJobStatus, setTestJobStatus] = useState<"idle" | "creating" | "success" | "error">("idle");
  const [testJobError, setTestJobError] = useState("");

  const hasTmux = tools.some((t) => t.name === "tmux" && t.available);
  const hasTelegram = tools.some((t) => t.name === "Telegram" && t.available);
  const hasTelegramConfigured = !!(telegramConfig && telegramConfig.chat_ids.length > 0);
  const availableEditors = EDITOR_OPTIONS.filter((opt) =>
    tools.some((t) => t.group === "editor" && t.available && t.name === opt.value),
  );

  // Filter steps: skip first-job if telegram is not configured
  const visibleSteps = STEPS.filter((s) => {
    if (s.id === "first-job" && !hasTelegramConfigured) return false;
    return true;
  });

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
    invoke<TelegramConfig | null>("get_telegram_config").then((cfg) => {
      if (cfg) {
        setTelegramConfig(cfg);
        setNotifySuccess(cfg.notify_on_success);
        setNotifyFailure(cfg.notify_on_failure);
        setAgentEnabled(cfg.agent_enabled);
      }
      setTelegramLoaded(true);
    });
  }, []);

  const currentIdx = visibleSteps.findIndex((s) => s.id === currentStep);

  const goNext = () => {
    if (currentIdx < visibleSteps.length - 1) {
      setCurrentStep(visibleSteps[currentIdx + 1].id);
    }
  };

  const goBack = () => {
    if (currentIdx > 0) {
      setCurrentStep(visibleSteps[currentIdx - 1].id);
    }
  };

  const editorLabel = EDITOR_OPTIONS.find((e) => e.value === preferredEditor)?.label ?? preferredEditor;

  const handleTelegramComplete = async (config: TelegramConfig) => {
    try {
      await invoke("set_telegram_config", { config });
      setTelegramConfig(config);
      setNotifySuccess(config.notify_on_success);
      setNotifyFailure(config.notify_on_failure);
      setAgentEnabled(config.agent_enabled);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

  const saveTelegramSettings = async (overrides: Partial<TelegramConfig>) => {
    if (!telegramConfig) return;
    const updated: TelegramConfig = { ...telegramConfig, ...overrides };
    try {
      await invoke("set_telegram_config", { config: updated });
      setTelegramConfig(updated);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

  const handleCreateTestJob = async () => {
    if (!telegramConfig || telegramConfig.chat_ids.length === 0) return;
    setTestJobStatus("creating");
    setTestJobError("");
    try {
      const testJob: Job = {
        name: "telegram-test",
        job_type: "binary",
        enabled: true,
        path: "echo",
        args: ["ClawTab setup complete -- telegram notifications are working."],
        cron: "",
        secret_keys: [],
        env: {},
        work_dir: null,
        tmux_session: null,
        aerospace_workspace: null,
        folder_path: null,
        job_name: null,
        telegram_chat_id: telegramConfig.chat_ids[0],
        telegram_log_mode: "off",
        group: "default",
        slug: "",
      };
      await invoke("save_job", { job: testJob });
      await invoke("run_job_now", { name: "telegram-test" });
      setTestJobStatus("success");
    } catch (e) {
      setTestJobStatus("error");
      setTestJobError(String(e));
    }
  };

  const handleFinish = async () => {
    if (!settings) return;
    const updated: AppSettings = {
      ...settings,
      claude_path: claudePath,
      default_work_dir: workDir,
      default_tmux_session: tmuxSession,
      preferred_terminal: settings.preferred_terminal,
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
      <h2>ClawTab Setup</h2>

      <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
        {visibleSteps.map((step, idx) => (
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
        Step {currentIdx + 1} of {visibleSteps.length}: {visibleSteps[currentIdx].label}
      </p>

      {currentStep === "tools" && (
        <div>
          <h3>Detected Tools</h3>
          <p className="section-description">
            These tools were found on your system. tmux is required -- install it before
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
          {!hasTmux && tools.length > 0 && (
            <p style={{ color: "var(--danger-color)", marginTop: 12 }}>
              tmux is required to continue. Use the install button above or run{" "}
              <code>brew install tmux</code> in your terminal, then click Refresh.
            </p>
          )}
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
            Secrets are managed by gopass or stored in macOS Keychain, and injected as environment
            variables into jobs.
            {gopassAvailable
              ? " gopass is available on your system. Imported gopass secrets stay in your gopass store and are refreshed on each app startup."
              : " gopass was not detected. You can add secrets manually to Keychain in the Secrets tab."}
          </p>
          <p>You can configure secrets after setup in the Secrets tab.</p>
        </div>
      )}

      {currentStep === "telegram" && telegramLoaded && (
        <div>
          <h3>Telegram Notifications</h3>
          {telegramSkipped ? (
            <div>
              <p className="section-description">
                Telegram setup skipped. You can configure it later from the Telegram tab.
              </p>
              <button
                className="btn btn-sm"
                onClick={() => setTelegramSkipped(false)}
              >
                Set up now
              </button>
            </div>
          ) : (
            <div>
              <p className="section-description">
                Set up a Telegram bot to receive job notifications and send commands.
                {!hasTelegram && " Telegram desktop app was not detected -- install it for the best experience."}
              </p>
              <TelegramSetup
                embedded
                initialConfig={telegramConfig}
                onComplete={(config) => {
                  handleTelegramComplete(config);
                }}
              />

              {telegramConfig && telegramConfig.chat_ids.length > 0 && (
                <>
                  <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
                  <h4>Notifications</h4>
                  <div className="form-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={notifySuccess}
                        onChange={(e) => {
                          setNotifySuccess(e.target.checked);
                          saveTelegramSettings({ notify_on_success: e.target.checked });
                        }}
                      />{" "}
                      Notify on job success
                    </label>
                  </div>
                  <div className="form-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={notifyFailure}
                        onChange={(e) => {
                          setNotifyFailure(e.target.checked);
                          saveTelegramSettings({ notify_on_failure: e.target.checked });
                        }}
                      />{" "}
                      Notify on job failure
                    </label>
                  </div>

                  <h4>Agent Mode</h4>
                  <div className="form-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={agentEnabled}
                        onChange={(e) => {
                          setAgentEnabled(e.target.checked);
                          saveTelegramSettings({ agent_enabled: e.target.checked });
                        }}
                      />{" "}
                      Enable agent mode
                    </label>
                  </div>
                </>
              )}

              {!telegramConfig && (
                <button
                  className="btn btn-sm"
                  onClick={() => { setTelegramSkipped(true); goNext(); }}
                  style={{ marginTop: 8 }}
                >
                  Skip for now
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {currentStep === "first-job" && (
        <div>
          <h3>Test Job</h3>
          <p className="section-description">
            Create a test job to verify Telegram notifications are working.
            This creates a simple "telegram-test" job that sends a message to your configured chat.
          </p>

          <div className="field-group" style={{ marginTop: 16 }}>
            <span className="field-group-title">Pre-filled test job</span>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <p style={{ margin: "0 0 4px" }}><strong>Name:</strong> telegram-test</p>
              <p style={{ margin: "0 0 4px" }}><strong>Type:</strong> Binary (echo)</p>
              <p style={{ margin: "0 0 4px" }}><strong>Schedule:</strong> Manual only</p>
              <p style={{ margin: "0 0 4px" }}>
                <strong>Telegram:</strong>{" "}
                {telegramConfig?.chat_ids[0] ?? "none"}
              </p>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            {testJobStatus === "idle" && (
              <div className="btn-group">
                <button className="btn btn-primary" onClick={handleCreateTestJob}>
                  Create & Run
                </button>
                <button className="btn" onClick={goNext}>
                  Skip
                </button>
              </div>
            )}

            {testJobStatus === "creating" && (
              <p className="text-secondary">Creating and running test job...</p>
            )}

            {testJobStatus === "success" && (
              <div>
                <p style={{ color: "var(--success-color)" }}>
                  Test job created and triggered. Check your Telegram for a message.
                </p>
                <button className="btn btn-primary" onClick={goNext} style={{ marginTop: 8 }}>
                  Continue
                </button>
              </div>
            )}

            {testJobStatus === "error" && (
              <div>
                <p style={{ color: "var(--danger-color)" }}>
                  Failed: {testJobError}
                </p>
                <div className="btn-group" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={handleCreateTestJob}>
                    Retry
                  </button>
                  <button className="btn" onClick={goNext}>
                    Skip
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {currentStep === "done" && (
        <div>
          <h3>Setup Complete</h3>
          <p className="section-description">
            ClawTab is ready to use. You can create your first job from the Jobs tab,
            or re-run this wizard from Settings.
          </p>
          <div style={{ marginTop: 12 }}>
            <p><strong>Tmux Session:</strong> {tmuxSession || "(default)"}</p>
            <p><strong>Editor:</strong> {editorLabel}</p>
            <p><strong>Telegram:</strong> {telegramConfig ? "Configured" : "Not configured"}</p>
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
        ) : currentStep === "first-job" ? (
          null
        ) : currentStep === "telegram" && !telegramConfig?.chat_ids?.length && !telegramSkipped ? (
          null
        ) : currentStep === "tools" && !hasTmux && tools.length > 0 ? (
          <button className="btn btn-primary" disabled>
            Next
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
