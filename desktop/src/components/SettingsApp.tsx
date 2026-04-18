import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { JobsTab } from "./JobsTab";
import { SecretsPanel } from "./SecretsPanel";
import { GeneralSettings } from "./GeneralSettings";
import { SkillsPanel } from "./SkillsPanel";
import { UsagePanel } from "./UsagePanel";
import type { SettingsSubTab } from "./GeneralSettings";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GearIcon } from "./icons";
import clawIcon from "../assets/icon.png";

type TabId = "jobs" | "secrets" | "skills" | "usage" | "settings";

interface RelayStatusLite {
  enabled: boolean;
  connected: boolean;
  auth_expired: boolean;
  configured: boolean;
  subscription_required: boolean;
}

const isSetupWindow = new URLSearchParams(window.location.search).has("setup");

// SF Symbol-style icons (clock, shield.lock, clock.arrow.circlepath, wrench, paperplane, gearshape)
const tabIcons: Record<TabId, React.ReactNode> = {
  // clock (SF: clock)
  jobs: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  // lock.shield (SF: lock.shield)
  secrets: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7L12 2z" />
      <path d="M12 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
      <path d="M12 11v3" />
    </svg>
  ),
  // book (SF: book)
  skills: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  ),
  // gauge (SF: gauge)
  usage: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14a8 8 0 1 1 16 0" />
      <path d="M12 14l4-4" />
      <path d="M7 19h10" />
    </svg>
  ),
  // gearshape (SF: gearshape)
  settings: <GearIcon size={14} />,
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
  const [importCwtKey, setImportCwtKey] = useState(0);
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>("general");
  const [relayAlert, setRelayAlert] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      invoke<RelayStatusLite>("get_relay_status")
        .then((s) => {
          if (cancelled) return;
          const disconnected = s.enabled && s.configured && !s.connected && !s.subscription_required;
          setRelayAlert(s.auth_expired || disconnected);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

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

  useEffect(() => {
    const unlistenPromise = listen<AppSettings>("settings-updated", () => {});
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("import-cwt", () => {
      setActiveTab("jobs");
      setImportCwtKey((k) => k + 1);
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>("open-pane", (event) => {
      setActiveTab("jobs");
      setPendingPaneId(event.payload);
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  const handleDeepLinks = (urls: string[]) => {
    for (const url of urls) {
      console.log("deep-link received:", url);
      invoke("show_settings_window");

      const paneMatch = url.match(/^clawtab:\/\/pane\/(.+)/);
      if (paneMatch) {
        setActiveTab("jobs");
        setPendingPaneId(decodeURIComponent(paneMatch[1]));
        continue;
      }

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
        setActiveTab("settings");
        setSettingsSubTab("remote");
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
    // Check for deep links that arrived before listener was registered
    getCurrent().then((urls) => {
      if (urls && urls.length > 0) {
        console.log("getCurrent deep links:", urls);
        handleDeepLinks(urls);
      }
    }).catch((e) => console.error("getCurrent failed:", e));

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", overflow: "auto", background: "var(--bg-secondary)" }}>
        <SetupWizard onComplete={handleWizardComplete} />
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "secrets", label: "Secrets" },
    { id: "skills", label: "Skills" },
    { id: "usage", label: "Usage" },
    { id: "settings", label: "Settings" },
  ];

  const navBar = (notificationsButton: React.ReactNode) => (
    <div className="nav-bar" data-tauri-drag-region>
      <button
        className="add-job-btn"
        onClick={() => {
          setActiveTab("jobs");
          setCreateJobKey((k) => k + 1);
        }}
        title="Add job"
      >
        <span style={{ position: 'relative', top: -1, fontSize: 14 }}>+</span>
      </button>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => {
            if (tab.id === "jobs" && activeTab === "jobs") {
              setJobsResetKey((k) => k + 1);
            }
            if (tab.id === "settings") {
              setSettingsSubTab(relayAlert ? "remote" : "general");
            }
            setActiveTab((current) => (current === tab.id ? "jobs" : tab.id));
          }}
          title={tab.id === "settings" && relayAlert ? "Settings (relay needs attention)" : tab.label}
        >
          <span className="tab-icon">{tabIcons[tab.id]}</span>
          {tab.id === "settings" && relayAlert && <span className="tab-alert-dot" />}
        </button>
      ))}
      {notificationsButton}
      <button
        className="claw-icon-btn"
        onClick={() => openUrl("https://clawtab.cc")}
        title="Open ClawTab website"
      >
        <img src={clawIcon} alt="ClawTab" width={18} height={18} style={{ borderRadius: 3 }} />
      </button>
    </div>
  );

  const panelClose = (
    <button
      className="panel-close-btn"
      onClick={() => setActiveTab("jobs")}
      title="Close panel"
    >
      <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M2 2l10 10M12 2L2 12" />
      </svg>
    </button>
  );

  const renderPanel = (id: TabId, label: string, content: React.ReactNode) => (
    <div key={id} style={{ display: activeTab === id ? "flex" : "none", flexDirection: "column", flex: 1, position: "absolute", inset: 0, background: "var(--bg-secondary)", zIndex: 20000 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "12px 20px 0", flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{label}</span>
        {panelClose}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 20px 20px" }}>
        {content}
      </div>
    </div>
  );

  const rightPanelOverlay = (
    <>
      {renderPanel("secrets", "Secrets", <SecretsPanel />)}
      {renderPanel("skills", "Skills", <SkillsPanel />)}
      {renderPanel("usage", "Usage", <UsagePanel />)}
      {renderPanel("settings", "Settings",
        <GeneralSettings
          activeSubTab={settingsSubTab}
          onSubTabChange={setSettingsSubTab}
          externalAccessToken={authCallbackToken}
          externalRefreshToken={authCallbackRefreshToken}
          onExternalTokenConsumed={() => { setAuthCallbackToken(null); setAuthCallbackRefreshToken(null); }}
        />
      )}
    </>
  );

  return (
    <div className="settings-container">
      <div className="tab-content">
        <JobsTab
          key={jobsResetKey}
          pendingTemplateId={pendingTemplateId}
          onTemplateHandled={() => setPendingTemplateId(null)}
          createJobKey={createJobKey}
          importCwtKey={importCwtKey}
          pendingPaneId={pendingPaneId}
          onPaneHandled={() => setPendingPaneId(null)}
          navBar={navBar}
          rightPanelOverlay={rightPanelOverlay}
          onJobSelected={() => setActiveTab("jobs")}
        />
      </div>
    </div>
  );
}
