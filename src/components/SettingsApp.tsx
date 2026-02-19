import { useState } from "react";
import { JobsPanel } from "./JobsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { GeneralSettings } from "./GeneralSettings";
import { ToolsPanel } from "./ToolsPanel";

type TabId = "jobs" | "secrets" | "history" | "tools" | "settings";

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>("jobs");

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "jobs", label: "Jobs", icon: "\u23F0" },
    { id: "secrets", label: "Secrets", icon: "\u26BF" },
    { id: "history", label: "History", icon: "\u2630" },
    { id: "tools", label: "Tools", icon: "\u2692" },
    { id: "settings", label: "Settings", icon: "\u2699" },
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
        {activeTab === "settings" && <GeneralSettings />}
      </div>
    </div>
  );
}
