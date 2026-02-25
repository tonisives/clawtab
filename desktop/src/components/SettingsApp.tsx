import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { JobsPanel } from "./JobsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { GeneralSettings } from "./GeneralSettings";
import { SkillsPanel } from "./SkillsPanel";
import { TelegramPanel } from "./TelegramPanel";
import { RelayPanel } from "./RelayPanel";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GearIcon } from "./icons";
import clawIcon from "../assets/icon.png";

type TabId = "jobs" | "secrets" | "skills" | "telegram" | "remote" | "settings";

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
  // book (SF: book)
  skills: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  ),
  // paperplane (SF: paperplane)
  telegram: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  ),
  // antenna.radiowaves.left.and.right (SF: remote access)
  remote: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" x2="12.01" y1="20" y2="20" />
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
  const [createJobKey, setCreateJobKey] = useState(0);
  const [authCallbackToken, setAuthCallbackToken] = useState<string | null>(null);
  const [authCallbackRefreshToken, setAuthCallbackRefreshToken] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        if (!s.setup_completed && !isSetupWindow) {
          setShowWizard(true);
        }
      })
      .catch((e) => console.error("Failed to load settings:", e))
      .finally(() => setLoading(false));
  }, []);

  const handleDeepLinks = (urls: string[]) => {
    for (const url of urls) {
      console.log("deep-link received:", url);
      invoke("show_settings_window");

      const templateMatch = url.match(/^clawtab:\/\/template\/(.+)/);
      if (templateMatch) {
        setActiveTab("jobs");
        setPendingTemplateId(templateMatch[1]);
        continue;
      }

      if (url.includes("auth/callback")) {
        const queryString = url.split("?")[1] ?? "";
        const params = new URLSearchParams(queryString);
        const accessToken = params.get("access_token");
        const refreshTokenVal = params.get("refresh_token");
        const error = params.get("error");
        console.log("auth callback:", { accessToken: !!accessToken, error });
        setActiveTab("remote");
        if (accessToken) {
          setAuthCallbackToken(accessToken);
          if (refreshTokenVal) {
            setAuthCallbackRefreshToken(refreshTokenVal);
          }
        } else if (error) {
          console.error("Google auth callback error:", error);
        }
      }
    }
  };

  useEffect(() => {
    let unlisten: ReturnType<typeof onOpenUrl> | null = null;
    try {
      unlisten = onOpenUrl((urls) => {
        console.log("onOpenUrl fired:", urls);
        handleDeepLinks(urls);
      });
    } catch (e) {
      console.error("Failed to register deep-link handler:", e);
    }
    return () => {
      unlisten?.then((fn) => fn());
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
    { id: "skills", label: "Skills" },
    { id: "telegram", label: "Telegram" },
    { id: "remote", label: "Remote" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="settings-container">
      <div className="tabs">
        <button
          className="add-job-btn"
          onClick={() => {
            setActiveTab("jobs");
            setCreateJobKey((k) => k + 1);
          }}
          title="Add job"
        >
          <span style={{ position: 'relative', top: -1 }}>+</span>
        </button>
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
            createJobKey={createJobKey}
          />
        </div>
        {activeTab === "secrets" && <SecretsPanel />}
        {activeTab === "skills" && <SkillsPanel />}
        {activeTab === "telegram" && <TelegramPanel />}
        {activeTab === "remote" && (
          <RelayPanel
            externalAccessToken={authCallbackToken}
            externalRefreshToken={authCallbackRefreshToken}
            onExternalTokenConsumed={() => { setAuthCallbackToken(null); setAuthCallbackRefreshToken(null); }}
          />
        )}
        {activeTab === "settings" && <GeneralSettings />}
      </div>
    </div>
  );
}
