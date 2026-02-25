import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, Job, TelegramConfig, ToolInfo } from "../types";
import { ToolGroupList } from "./ToolGroupList";
import { TelegramSetup } from "./TelegramSetup";

type Props = {
  onComplete: () => void;
};

type Step = "welcome" | "tools" | "telegram" | "hello-world" | "web-browse" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "tools", label: "Tools" },
  { id: "telegram", label: "Telegram" },
  { id: "hello-world", label: "Hello World" },
  { id: "web-browse", label: "Web Browse" },
  { id: "done", label: "Done" },
];

const REQUIRED_CATEGORIES = new Set(["AI Agent", "Required", "Terminal", "Editor", "Browser"]);

export function SetupWizard({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState<Step>("welcome");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [preferredTerminal, setPreferredTerminal] = useState("auto");
  const [preferredEditor, setPreferredEditor] = useState("");
  const [telegramConfig, setTelegramConfig] = useState<TelegramConfig | null>(null);
  const [telegramLoaded, setTelegramLoaded] = useState(false);

  // Hello World job state
  const [helloStatus, setHelloStatus] = useState<"idle" | "creating" | "success" | "error">("idle");
  const [helloError, setHelloError] = useState("");

  // Web Browse job state
  const [browseStatus, setBrowseStatus] = useState<"idle" | "creating" | "success" | "error">("idle");
  const [browseError, setBrowseError] = useState("");

  const hasTmux = tools.some((t) => t.name === "tmux" && t.available);
  const hasAiAgent = tools.some((t) => t.category === "AI Agent" && t.available);
  const hasTerminal = tools.some((t) => t.category === "Terminal" && t.available);
  const hasEditor = tools.some((t) => t.category === "Editor" && t.available);
  const requiredTools = tools.filter((t) => REQUIRED_CATEGORIES.has(t.category));

  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  const loadTools = async () => {
    const detected = await invoke<ToolInfo[]>("detect_tools");
    setTools(detected);
  };

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setSettings(s);
      setClaudePath(s.claude_path);
      setPreferredTerminal(s.preferred_terminal);
      setPreferredEditor(s.preferred_editor);
    });
    loadTools();
    invoke<TelegramConfig | null>("get_telegram_config").then((cfg) => {
      if (cfg) {
        setTelegramConfig(cfg);
      }
      setTelegramLoaded(true);
    });
  }, []);

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

  const handleTelegramComplete = async (config: TelegramConfig) => {
    try {
      await invoke("set_telegram_config", { config });
      setTelegramConfig(config);
    } catch (e) {
      console.error("Failed to save telegram config:", e);
    }
  };

  const handleCreateHelloWorld = async () => {
    if (!telegramConfig || telegramConfig.chat_ids.length === 0) return;
    setHelloStatus("creating");
    setHelloError("");
    try {
      const job: Job = {
        name: "hello-world",
        job_type: "binary",
        enabled: true,
        path: "echo",
        args: ["Hello World from ClawTab"],
        cron: "",
        secret_keys: [],
        env: {},
        work_dir: null,
        tmux_session: null,
        aerospace_workspace: null,
        folder_path: null,
        job_name: "default",
        telegram_chat_id: telegramConfig.chat_ids[0],
        telegram_log_mode: "on_prompt",
        telegram_notify: { start: true, working: true, logs: true, finish: true },
        group: "tutorial",
        slug: "",
        skill_paths: [],
      };
      await invoke("save_job", { job });
      await invoke("run_job_now", { name: "hello-world" });
      setHelloStatus("success");
    } catch (e) {
      setHelloStatus("error");
      setHelloError(String(e));
    }
  };

  const handleCreateWebBrowse = async () => {
    if (!telegramConfig || telegramConfig.chat_ids.length === 0 || !settings) return;
    setBrowseStatus("creating");
    setBrowseError("");
    try {
      const workDir = settings.default_work_dir || "~";
      const folderPath = workDir.replace(/\/+$/, "") + "/.cwt";
      const jobName = "hacker-news";

      await invoke("init_cwt_folder", { folderPath, jobName });

      const jobMd = [
        "# Hacker News",
        "",
        "1. Use the WebFetch tool to fetch https://news.ycombinator.com/ and extract the top stories.",
        "2. Pick the top 5 most interesting stories from the front page.",
        "3. For each story, include the title, points, and comment count.",
        "4. Send the results to Telegram.",
      ].join("\n");

      await invoke("write_cwt_entry", { folderPath, jobName, content: jobMd });

      const chatId = telegramConfig.chat_ids[0];
      const job: Job = {
        name: "Hacker News",
        job_type: "folder",
        enabled: true,
        path: "",
        args: [],
        cron: "",
        secret_keys: [],
        env: {},
        work_dir: null,
        tmux_session: null,
        aerospace_workspace: null,
        folder_path: folderPath,
        job_name: jobName,
        telegram_chat_id: chatId,
        telegram_log_mode: "on_prompt",
        telegram_notify: { start: true, working: true, logs: true, finish: true },
        group: "tutorial",
        slug: "",
        skill_paths: [],
      };
      await invoke("save_job", { job });
      await invoke("run_job_now", { name: "Hacker News" });
      setBrowseStatus("success");
    } catch (e) {
      setBrowseStatus("error");
      setBrowseError(String(e));
    }
  };

  const handleFinish = async () => {
    if (!settings) return;
    const updated: AppSettings = {
      ...settings,
      claude_path: claudePath,
      preferred_terminal: preferredTerminal,
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

  const toolsReady = hasTmux && hasAiAgent && hasTerminal && hasEditor;
  const telegramReady = !!(telegramConfig && telegramConfig.chat_ids.length > 0);

  const canAdvance = (): boolean => {
    if (currentStep === "tools") return toolsReady;
    if (currentStep === "telegram") return telegramReady;
    if (currentStep === "hello-world") return helloStatus === "success";
    if (currentStep === "web-browse") return browseStatus === "success";
    return true;
  };

  return (
    <div className="settings-section" style={{ maxWidth: 600, margin: "0 auto" }}>
      <h2>ClawTab Setup</h2>

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

      {currentStep === "welcome" && (
        <div>
          <h3>Welcome to ClawTab</h3>
          <p className="section-description">
            We'll set up Telegram and create your first two Claude Code jobs.
            This takes about 5 minutes.
          </p>
          <div style={{ marginTop: 16, fontSize: 13, lineHeight: 1.8, color: "var(--text-secondary)" }}>
            <p style={{ margin: "0 0 4px" }}>1. Check that required tools are installed</p>
            <p style={{ margin: "0 0 4px" }}>2. Connect your Telegram bot</p>
            <p style={{ margin: "0 0 4px" }}>3. Create and run a Hello World job</p>
            <p style={{ margin: "0 0 4px" }}>4. Create and run a web browsing job</p>
          </div>
        </div>
      )}

      {currentStep === "tools" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Tools</h3>
            <button className="btn btn-sm" onClick={loadTools}>
              Rescan
            </button>
          </div>
          <p className="section-description">
            These tools are needed to run ClawTab. You can change tool paths later in Settings.
          </p>
          <ToolGroupList
            tools={requiredTools}
            onRefresh={loadTools}
            selections={{
              terminal: preferredTerminal === "auto" ? "" : preferredTerminal,
              editor: preferredEditor,
            }}
            onSelect={(group, toolName) => {
              if (group === "terminal") setPreferredTerminal(toolName);
              if (group === "editor") setPreferredEditor(toolName);
            }}
          />
          {!hasAiAgent && tools.length > 0 && (
            <p style={{ color: "var(--danger-color)", marginTop: 12 }}>
              Claude Code is required. Run <code>npm install -g @anthropic-ai/claude-code</code> then click Rescan.
            </p>
          )}
          {!hasTmux && tools.length > 0 && (
            <p style={{ color: "var(--danger-color)", marginTop: 12 }}>
              tmux is required. Run <code>brew install tmux</code> then click Rescan.
            </p>
          )}
          {!hasTerminal && tools.length > 0 && (
            <p style={{ color: "var(--danger-color)", marginTop: 12 }}>
              A terminal emulator is required.
            </p>
          )}
          {!hasEditor && tools.length > 0 && (
            <p style={{ color: "var(--danger-color)", marginTop: 12 }}>
              A code editor is required.
            </p>
          )}
        </div>
      )}

      {currentStep === "telegram" && telegramLoaded && (
        <div>
          <h3>Telegram Setup</h3>
          <p className="section-description">
            Set up a Telegram bot to receive job notifications and send commands.
            This is required for the tutorial jobs.
          </p>
          <TelegramSetup
            embedded
            initialConfig={telegramConfig}
            onComplete={handleTelegramComplete}
          />
        </div>
      )}

      {currentStep === "hello-world" && (
        <div>
          <h3>Hello World Job</h3>
          <p className="section-description">
            Your first job -- a simple echo command that sends a message to Telegram.
            This verifies everything is wired up correctly.
          </p>

          <div className="field-group" style={{ marginTop: 16 }}>
            <span className="field-group-title">Pre-filled job</span>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <p style={{ margin: "0 0 4px" }}><strong>Name:</strong> hello-world</p>
              <p style={{ margin: "0 0 4px" }}><strong>Type:</strong> Binary (echo)</p>
              <p style={{ margin: "0 0 4px" }}><strong>Command:</strong> echo "Hello World from ClawTab"</p>
              <p style={{ margin: "0 0 4px" }}>
                <strong>Telegram:</strong>{" "}
                {telegramConfig?.chat_ids[0] ?? "none"}
              </p>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            {helloStatus === "idle" && (
              <button className="btn btn-primary" onClick={handleCreateHelloWorld}>
                Create & Run
              </button>
            )}

            {helloStatus === "creating" && (
              <p className="text-secondary">Creating and running job...</p>
            )}

            {helloStatus === "success" && (
              <div>
                <p style={{ color: "var(--success-color)" }}>
                  Job created and running. Check your Telegram for a message.
                </p>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    try {
                      await invoke("run_job_now", { name: "hello-world" });
                    } catch (e) {
                      console.error("Failed to re-run hello-world:", e);
                    }
                  }}
                >
                  Run Again
                </button>
              </div>
            )}

            {helloStatus === "error" && (
              <div>
                <p style={{ color: "var(--danger-color)" }}>
                  Failed: {helloError}
                </p>
                <button className="btn" onClick={handleCreateHelloWorld} style={{ marginTop: 8 }}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {currentStep === "web-browse" && (
        <div>
          <h3>Web Browse Job</h3>
          <p className="section-description">
            Your first real AI job -- Claude will fetch the Hacker News front page
            and send you the top stories via Telegram.
          </p>

          <div className="field-group" style={{ marginTop: 16 }}>
            <span className="field-group-title">Pre-filled job</span>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <p style={{ margin: "0 0 4px" }}><strong>Name:</strong> Hacker News</p>
              <p style={{ margin: "0 0 4px" }}><strong>Type:</strong> Folder (Claude Code)</p>
              <p style={{ margin: "0 0 4px" }}>
                <strong>Directory:</strong>{" "}
                {(settings?.default_work_dir || "~").replace(/\/+$/, "")}/.cwt/hacker-news/
              </p>
              <p style={{ margin: "0 0 4px" }}>
                <strong>Telegram:</strong>{" "}
                {telegramConfig?.chat_ids[0] ?? "none"}
              </p>
            </div>
          </div>

          <p className="text-secondary" style={{ fontSize: 12, marginTop: 12 }}>
            Claude Code will use its built-in web browsing to fetch the page.
          </p>

          <div style={{ marginTop: 16 }}>
            {browseStatus === "idle" && (
              <button className="btn btn-primary" onClick={handleCreateWebBrowse}>
                Create & Run
              </button>
            )}

            {browseStatus === "creating" && (
              <p className="text-secondary">Creating folder and running job...</p>
            )}

            {browseStatus === "success" && (
              <div>
                <p style={{ color: "var(--success-color)" }}>
                  Job created and running. Claude is fetching Hacker News -- check Telegram for results.
                </p>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    try {
                      await invoke("run_job_now", { name: "Hacker News" });
                    } catch (e) {
                      console.error("Failed to re-run Hacker News:", e);
                    }
                  }}
                >
                  Run Again
                </button>
              </div>
            )}

            {browseStatus === "error" && (
              <div>
                <p style={{ color: "var(--danger-color)" }}>
                  Failed: {browseError}
                </p>
                <button className="btn" onClick={handleCreateWebBrowse} style={{ marginTop: 8 }}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {currentStep === "done" && (
        <div>
          <h3>Setup Complete</h3>
          <p className="section-description">
            ClawTab is ready. Your two tutorial jobs are in the Jobs tab -- you can
            edit, schedule, or create new ones from there.
          </p>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ margin: "0 0 4px" }}><strong>Telegram:</strong> Connected</p>
            <p style={{ margin: "0 0 4px" }}><strong>Jobs created:</strong> hello-world, Hacker News</p>
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
            Go to Jobs
          </button>
        ) : currentStep === "hello-world" || currentStep === "web-browse" ? (
          canAdvance() ? (
            <button className="btn btn-primary" onClick={goNext}>
              Next
            </button>
          ) : null
        ) : (
          <button
            className="btn btn-primary"
            onClick={goNext}
            disabled={!canAdvance()}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
