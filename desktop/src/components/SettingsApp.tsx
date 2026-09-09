import { useEffect, useRef, useState, type UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { DesktopMachinesPanel } from "./DesktopMachinesPanel";
import { JobsTab } from "./JobsTab";
import { MindMapPanel } from "./MindMap";
import { GeneralSettings, readStoredSettingsSubTab } from "./GeneralSettings";
import type { SettingsSubTab } from "./GeneralSettings";
import { SetupWizard } from "./SetupWizard";
import type { AppSettings } from "../types";
import { AboutPanel } from "./AboutPanel";
import { GearIcon } from "./icons";
import clawIcon from "../assets/icon.png";

type TabId = "jobs" | "mindmap" | "machines" | "settings" | "about";
const tabIds: TabId[] = ["jobs", "mindmap", "machines", "settings", "about"];
const SETTINGS_ACTIVE_TAB_KEY = "desktop_settings_active_tab";
const PANEL_SCROLL_PREFIX = "desktop_settings_panel_scroll";

interface RelayStatusLite {
  enabled: boolean;
  connected: boolean;
  auth_expired: boolean;
  configured: boolean;
  subscription_required: boolean;
}

const isSetupWindow = new URLSearchParams(window.location.search).has("setup");

function readStoredTab(): TabId {
  if (typeof localStorage === "undefined") return "jobs";
  try {
    const value = localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY);
    if (["secrets", "skills", "usage"].includes(value ?? "")) return "settings";
    return tabIds.includes(value as TabId) ? (value as TabId) : "jobs";
  } catch {
    return "jobs";
  }
}

function panelScrollKey(id: TabId): string {
  return `${PANEL_SCROLL_PREFIX}_${id}`;
}

// SF Symbol-style icons (clock, shield.lock, clock.arrow.circlepath, wrench, paperplane, gearshape)
const tabIcons: Partial<Record<TabId, React.ReactNode>> = {
  // clock (SF: clock)
  jobs: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  // sparkles / constellation
  mindmap: (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="6" r="1.6" />
      <circle cx="19" cy="6" r="1.6" />
      <circle cx="5" cy="18" r="1.6" />
      <circle cx="19" cy="18" r="1.6" />
      <line x1="12" y1="12" x2="5" y2="6" />
      <line x1="12" y1="12" x2="19" y2="6" />
      <line x1="12" y1="12" x2="5" y2="18" />
      <line x1="12" y1="12" x2="19" y2="18" />
    </svg>
  ),
  machines: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 16v5" />
    </svg>
  ),
  // gearshape (SF: gearshape)
  settings: <GearIcon size={14} />,
};

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<TabId>(readStoredTab);
  const [jobsResetKey, setJobsResetKey] = useState(0);
  const [showWizard, setShowWizard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [createJobKey, setCreateJobKey] = useState(0);
  const [authCallbackToken, setAuthCallbackToken] = useState<string | null>(null);
  const [authCallbackRefreshToken, setAuthCallbackRefreshToken] = useState<string | null>(null);
  const [importCwtKey, setImportCwtKey] = useState(0);
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>(readStoredSettingsSubTab);
  const [relayAlert, setRelayAlert] = useState(false);
  const [daemonAlert, setDaemonAlert] = useState(false);
  const panelScrollRefs = useRef<Partial<Record<TabId, HTMLDivElement>>>({});

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, activeTab);
    } catch {
      // localStorage can be unavailable in test or restricted webview contexts.
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "jobs") return;
    const node = panelScrollRefs.current[activeTab];
    if (!node) return;
    let y = 0;
    try {
      const raw = localStorage.getItem(panelScrollKey(activeTab));
      y = raw ? Number(raw) : 0;
    } catch {
      y = 0;
    }
    if (!Number.isFinite(y)) return;
    const restore = () => {
      node.scrollTop = y;
    };
    const frame = requestAnimationFrame(restore);
    const timer = window.setTimeout(restore, 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [activeTab]);

  let openMachineAccount = () => {
    setSettingsSubTab("remote");
    setActiveTab("settings");
  };

  const handlePanelScroll = (id: TabId, event: UIEvent<HTMLDivElement>) => {
    try {
      localStorage.setItem(panelScrollKey(id), String(event.currentTarget.scrollTop));
    } catch {
      // Ignore persistence failures; scrolling should never be blocked by storage.
    }
  };

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
      invoke<{ installed: boolean; running: boolean }>("get_daemon_status")
        .then((s) => {
          if (cancelled) return;
          setDaemonAlert(s.installed && !s.running);
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
    { id: "mindmap", label: "Mind Map" },
    { id: "machines", label: "Machines" },
    { id: "settings", label: "Settings" },
  ];

  let openAbout = () => setActiveTab((current) => current === "about" ? "jobs" : "about");

  const navBar = (notificationsButton: React.ReactNode) => (
    <div className="nav-bar" data-tauri-drag-region>
      <button
        className={`claw-icon-btn ${activeTab === "about" ? "active" : ""}`}
        onClick={openAbout}
        title="About ClawTab"
        aria-label="About ClawTab"
        aria-pressed={activeTab === "about"}
      >
        <img src={clawIcon} alt="" width={18} height={18} className="nav-claw-icon" />
        <span className="nav-label">ClawTab</span>
      </button>
      <div className="nav-tools">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => {
              if (tab.id === "jobs" && activeTab === "jobs") {
                setJobsResetKey((k) => k + 1);
              }
              setActiveTab((current) => (current === tab.id ? "jobs" : tab.id));
            }}
            title={
              tab.id === "settings" && daemonAlert
                ? "Settings (daemon not running)"
                : tab.id === "settings" && relayAlert
                  ? "Settings (relay needs attention)"
                  : tab.label
            }
          >
            <span className="tab-icon">{tabIcons[tab.id]}</span>
            <span className="nav-label">{tab.label}</span>
            {tab.id === "settings" && (relayAlert || daemonAlert) && <span className="tab-alert-dot" />}
          </button>
        ))}
        {notificationsButton}
      </div>
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

  const renderPanel = (id: TabId, label: string, content: React.ReactNode, options?: { fullBleed?: boolean }) => {
    if (options?.fullBleed) {
      return (
        <div key={id} className="settings-panel-overlay settings-panel-overlay-full" style={{ display: activeTab === id ? "flex" : "none" }}>
          <div className="settings-panel-fullbleed-close">{panelClose}</div>
          <div
            ref={(node) => {
              if (node) panelScrollRefs.current[id] = node;
              else delete panelScrollRefs.current[id];
            }}
            className="settings-panel-body settings-panel-body-full"
            onScroll={(event) => handlePanelScroll(id, event)}
          >
            {content}
          </div>
        </div>
      );
    }
    return (
      <div key={id} className="settings-panel-overlay" style={{ display: activeTab === id ? "flex" : "none" }}>
        <div className="settings-panel-header" data-tauri-drag-region>
          <span className="settings-panel-title">{label}</span>
          {panelClose}
        </div>
        <div
          ref={(node) => {
            if (node) panelScrollRefs.current[id] = node;
            else delete panelScrollRefs.current[id];
          }}
          className="settings-panel-body"
          onScroll={(event) => handlePanelScroll(id, event)}
        >
          {content}
        </div>
      </div>
    );
  };

  const rightPanelOverlay = (
    <>
      {renderPanel("mindmap", "Mind Map", <MindMapPanel onRequestJobsTab={() => setActiveTab("jobs")} />, { fullBleed: true })}
      {renderPanel("about", "About ClawTab", <AboutPanel />)}
      {renderPanel("machines", "Machines", <DesktopMachinesPanel onOpenAccount={openMachineAccount} />)}
      {renderPanel("settings", "Settings",
        <GeneralSettings
          onAddJob={() => { setActiveTab("jobs"); setCreateJobKey((k) => k + 1); }}
          activeSubTab={settingsSubTab}
          onSubTabChange={setSettingsSubTab}
          externalAccessToken={authCallbackToken}
          externalRefreshToken={authCallbackRefreshToken}
          onExternalTokenConsumed={() => { setAuthCallbackToken(null); setAuthCallbackRefreshToken(null); }}
          daemonAlert={daemonAlert}
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
          onOpenSettings={() => {
            setActiveTab((current) => (current === "settings" ? "jobs" : "settings"));
          }}
          onSelectView={(viewId) => {
            if (viewId.startsWith("settings:")) {
              const sub = viewId.slice("settings:".length) as SettingsSubTab;
              setActiveTab("settings");
              setSettingsSubTab(sub);
              return;
            }
            setActiveTab(viewId as TabId);
          }}
        />
      </div>
    </div>
  );
}
