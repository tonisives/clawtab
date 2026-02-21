import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { JobsPanel } from "./JobsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { GeneralSettings } from "./GeneralSettings";
import { ToolsPanel } from "./ToolsPanel";
import { TelegramPanel } from "./TelegramPanel";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GearIcon } from "./icons";
import clawIcon from "../assets/icon.png";

type TabId = "jobs" | "secrets" | "tools" | "telegram" | "settings";

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
  settings: <GearIcon />,
};

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>("jobs");
  const [jobsResetKey, setJobsResetKey] = useState(0);
  const [showWizard, setShowWizard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      if (!s.setup_completed && !isSetupWindow) {
        setShowWizard(true);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      for (const url of urls) {
        const match = url.match(/^clawtab:\/\/template\/(.+)/);
        if (match) {
          invoke("show_settings_window");
          setActiveTab("jobs");
          setPendingTemplateId(match[1]);
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
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
            onClick={() => {
              if (tab.id === "jobs" && activeTab === "jobs") {
                setJobsResetKey((k) => k + 1);
              }
              setActiveTab(tab.id);
            }}
          >
            <span className="tab-icon">{tabIcons[tab.id]}</span>
            {tab.label}
          </button>
        ))}
        <button
          className="claw-icon-btn"
          onClick={() => openUrl("https://clawtab.cc")}
          title="Open ClawTab website"
        >
          <img src={clawIcon} alt="ClawTab" width={28} height={28} style={{ borderRadius: 6 }} />
        </button>
      </div>

      <div className="tab-content">
        <div style={{ display: activeTab === "jobs" ? undefined : "none" }}>
          <JobsPanel
            key={jobsResetKey}
            pendingTemplateId={pendingTemplateId}
            onTemplateHandled={() => setPendingTemplateId(null)}
          />
        </div>
        {activeTab === "secrets" && <SecretsPanel />}
        <div style={{ display: activeTab === "tools" ? undefined : "none" }}>
          <ToolsPanel />
        </div>
        {activeTab === "telegram" && <TelegramPanel />}
        {activeTab === "settings" && <GeneralSettings />}
      </div>
    </div>
  );
}
