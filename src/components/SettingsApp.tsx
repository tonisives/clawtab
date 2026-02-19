import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { JobsPanel } from "./JobsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { GeneralSettings } from "./GeneralSettings";
import { ToolsPanel } from "./ToolsPanel";
import { TelegramPanel } from "./TelegramPanel";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";

type TabId = "jobs" | "secrets" | "history" | "tools" | "telegram" | "settings" | "setup";

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>("jobs");
  const [showWizard, setShowWizard] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (!s.setup_completed) {
        setShowWizard(true);
      }
      setLoading(false);
    });
  }, []);

  const handleWizardComplete = () => {
    setShowWizard(false);
    setActiveTab("jobs");
  };

  if (loading) return null;

  if (showWizard) {
    return (
      <div className="settings-container">
        <div className="tab-content">
          <SetupWizard onComplete={handleWizardComplete} />
        </div>
      </div>
    );
  }

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "jobs", label: "Jobs", icon: "\u23F0" },
    { id: "secrets", label: "Secrets", icon: "\u26BF" },
    { id: "history", label: "History", icon: "\u2630" },
    { id: "tools", label: "Tools", icon: "\u2692" },
    { id: "telegram", label: "Telegram", icon: "\u2709" },
    { id: "settings", label: "Settings", icon: "\u2699" },
    { id: "setup", label: "Setup", icon: "\u2728" },
  ];

  return (
    <div className="settings-container">
      <div className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-icon">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {activeTab === "jobs" && <JobsPanel />}
        {activeTab === "secrets" && <SecretsPanel />}
        {activeTab === "history" && <HistoryPanel />}
        {activeTab === "tools" && <ToolsPanel />}
        {activeTab === "telegram" && <TelegramPanel />}
        {activeTab === "settings" && <GeneralSettings />}
        {activeTab === "setup" && (
          <SetupWizard onComplete={() => setActiveTab("jobs")} />
        )}
      </div>
    </div>
  );
}
