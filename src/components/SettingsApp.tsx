import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { JobsPanel } from "./JobsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { GeneralSettings } from "./GeneralSettings";
import { ToolsPanel } from "./ToolsPanel";
import { TelegramPanel } from "./TelegramPanel";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";

type TabId = "jobs" | "secrets" | "history" | "tools" | "telegram" | "settings";

const isSetupWindow = new URLSearchParams(window.location.search).has("setup");

// SF Symbol-style icons (clock, shield.lock, clock.arrow.circlepath, wrench, paperplane, gearshape)
const tabIcons: Record<TabId, React.ReactNode> = {
  // clock (SF: clock)
  jobs: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  // lock.shield (SF: lock.shield)
  secrets: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7L12 2z" />
      <path d="M12 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
      <path d="M12 11v3" />
    </svg>
  ),
  // clock.arrow.counterclockwise (SF: clock.arrow.circlepath)
  history: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  ),
  // wrench.and.screwdriver (SF: wrench.and.screwdriver)
  tools: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  // paperplane (SF: paperplane)
  telegram: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  ),
  // gearshape (SF: gearshape)
  settings: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>("jobs");
  const [showWizard, setShowWizard] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (!s.setup_completed && !isSetupWindow) {
        setShowWizard(true);
      }
      setLoading(false);
    });
  }, []);

  const handleWizardComplete = async () => {
    if (isSetupWindow) {
      await getCurrentWindow().close();
    } else {
      setShowWizard(false);
      setActiveTab("jobs");
    }
  };

  if (loading) return null;

  if (showWizard || isSetupWindow) {
    return (
      <div className="settings-container">
        <div className="tab-content">
          <SetupWizard onComplete={handleWizardComplete} />
        </div>
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "jobs", label: "Jobs" },
    { id: "secrets", label: "Secrets" },
    { id: "history", label: "History" },
    { id: "tools", label: "Tools" },
    { id: "telegram", label: "Telegram" },
    { id: "settings", label: "Settings" },
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
            <span className="tab-icon">{tabIcons[tab.id]}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        <div style={{ display: activeTab === "jobs" ? undefined : "none" }}>
          <JobsPanel />
        </div>
        {activeTab === "secrets" && <SecretsPanel />}
        {activeTab === "history" && <HistoryPanel />}
        <div style={{ display: activeTab === "tools" ? undefined : "none" }}>
          <ToolsPanel />
        </div>
        {activeTab === "telegram" && <TelegramPanel />}
        {activeTab === "settings" && <GeneralSettings />}
      </div>
    </div>
  );
}
