import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { colors, JobKindIcon, PopupMenu } from "@clawtab/shared";
import type { ProcessProvider } from "@clawtab/shared";
import {
  buildModelOptions,
} from "./JobEditor/utils";

const LAST_RUN_AGENT_FOLDER_KEY = "clawtab_last_run_agent_folder";

interface EmptyDetailAgentProps {
  onRunAgent: (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string) => void | Promise<void>;
  getAgentProviders: () => Promise<ProcessProvider[]>;
  defaultProvider: ProcessProvider;
  defaultModel?: string | null;
  enabledModels?: Record<string, string[]>;
  focusSignal?: number;
  folderGroups?: { group: string; folderPath: string }[];
  activeWorkspaceId?: string;
}

export function EmptyDetailAgent({ onRunAgent, getAgentProviders, defaultProvider, enabledModels = {}, folderGroups = [], activeWorkspaceId }: EmptyDetailAgentProps) {
  const [providers, setProviders] = useState<ProcessProvider[]>([defaultProvider]);
  const [workDir, setWorkDirState] = useState<string | null>(() => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(LAST_RUN_AGENT_FOLDER_KEY);
  });
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [folderMenuPos, setFolderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const folderButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentProviders()
      .then((list) => {
        if (!cancelled) setProviders(list.length > 0 ? list : [defaultProvider]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [defaultProvider, getAgentProviders]);

  const modelOptions = useMemo(
    () => buildModelOptions(providers, enabledModels),
    [providers, enabledModels],
  );

  const folderOptions = useMemo(() => {
    const seen = new Set<string>();
    return folderGroups.filter(({ folderPath }) => {
      if (!folderPath || seen.has(folderPath)) return false;
      seen.add(folderPath);
      return true;
    });
  }, [folderGroups]);

  const setWorkDir = useCallback((next: string | null) => {
    setWorkDirState(next);
    if (typeof localStorage === "undefined") return;
    if (next) localStorage.setItem(LAST_RUN_AGENT_FOLDER_KEY, next);
    else localStorage.removeItem(LAST_RUN_AGENT_FOLDER_KEY);
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const match = folderOptions.find((opt) => opt.group === activeWorkspaceId);
    if (match && match.folderPath !== workDir) setWorkDir(match.folderPath);
  }, [activeWorkspaceId, folderOptions, setWorkDir, workDir]);

  useEffect(() => {
    if (workDir) return;
    const firstFolder = folderOptions[0]?.folderPath;
    if (firstFolder) setWorkDir(firstFolder);
  }, [folderOptions, setWorkDir, workDir]);

  const selectedFolder = useMemo(() => {
    if (!workDir) return null;
    const match = folderOptions.find((option) => option.folderPath === workDir);
    return {
      group: match?.group ?? workDir.split("/").filter(Boolean).pop() ?? "Folder",
      folderPath: workDir,
      label: match?.group ?? workDir,
    };
  }, [folderOptions, workDir]);

  const handleFolderPick = useCallback(async () => {
    setFolderMenuOpen(false);
    const selected = await open({ directory: true, multiple: false, title: "Choose folder" });
    if (selected) {
      const dir = typeof selected === "string" ? selected : (selected as string[])[0];
      setWorkDir(dir?.replace(/\/+$/, "") ?? null);
    }
  }, [setWorkDir]);

  const launch = useCallback(async (provider: ProcessProvider, modelId: string | null) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onRunAgent("", workDir ?? undefined, provider, modelId ?? undefined);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [onRunAgent, workDir]);

  const launchableOptions = modelOptions.filter((opt) => opt.provider !== "shell");

  return (
    <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 360, maxWidth: "90%" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
          Run in folder
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            ref={folderButtonRef}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setFolderMenuPos({ top: rect.bottom + 6, left: rect.left });
              setFolderMenuOpen((open) => !open);
            }}
            title={selectedFolder ? selectedFolder.folderPath : "Pick folder"}
            style={{
              height: 30,
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 999,
              background: workDir ? "rgba(121, 134, 203, 0.12)" : "rgba(10, 10, 10, 0.55)",
              border: workDir ? "1px solid rgba(121, 134, 203, 0.25)" : "1px solid rgba(255, 255, 255, 0.08)",
              cursor: "pointer",
              color: workDir ? "var(--accent, #7986cb)" : "var(--text-muted)",
              fontSize: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "100%",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {selectedFolder ? selectedFolder.label : "Pick folder ..."}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 9, marginTop: -1 }}>&#9662;</span>
          </button>
        </div>
        <div style={launchListStyle}>
          {launchableOptions.map((opt, index) => (
            <Fragment key={`${opt.provider}:${opt.modelId ?? ""}`}>
              <div
                role="button"
                tabIndex={sending ? -1 : 0}
                aria-disabled={sending}
                onClick={() => { if (!sending) void launch(opt.provider, opt.modelId); }}
                onKeyDown={(e) => {
                  if (sending || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  void launch(opt.provider, opt.modelId);
                }}
                style={launchItemStyle(sending)}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18 }}>
                  <JobKindIcon kind={opt.provider} size={16} compact bare />
                </span>
                <span style={{ flex: 1, textAlign: "left" }}>{opt.label}</span>
              </div>
              {index < launchableOptions.length ? <div style={launchSeparatorStyle} /> : null}
            </Fragment>
          ))}
          <div
            role="button"
            tabIndex={sending ? -1 : 0}
            aria-disabled={sending}
            onClick={() => { if (!sending) void launch("shell", null); }}
            onKeyDown={(e) => {
              if (sending || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              void launch("shell", null);
            }}
            style={launchItemStyle(sending)}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18 }}>
              <JobKindIcon kind="shell" size={16} compact bare />
            </span>
            <span style={{ flex: 1, textAlign: "left" }}>Terminal</span>
          </div>
        </div>
      </div>
      {folderMenuOpen && (
        <PopupMenu
          items={[
            ...folderOptions.map((option) => ({
              type: "item" as const,
              label: option.group,
              hint: option.folderPath,
              active: option.folderPath === workDir,
              onPress: () => {
                setWorkDir(option.folderPath);
                setFolderMenuOpen(false);
              },
            })),
            ...(folderOptions.length > 0 ? [{ type: "separator" as const }] : []),
            {
              type: "item" as const,
              label: "...",
              onPress: () => { void handleFolderPick(); },
            },
          ]}
          position={folderMenuPos}
          onClose={() => setFolderMenuOpen(false)}
          triggerRef={folderButtonRef as any}
          autoFocus
        />
      )}
    </div>
  );
}

const launchListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  marginTop: 4,
  borderRadius: 8,
  overflow: "hidden",
  background: colors.groupedSurface,
};

const launchSeparatorStyle: CSSProperties = {
  height: 1,
  background: colors.border,
  flexShrink: 0,
};

function launchItemStyle(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    borderRadius: 0,
    background: "transparent",
    backgroundColor: "transparent",
    border: "none",
    appearance: "none",
    WebkitAppearance: "none",
    boxShadow: "none",
    cursor: disabled ? "default" : "pointer",
    color: colors.text,
    fontSize: 13,
    fontFamily: "inherit",
    margin: 0,
    outline: "none",
    opacity: disabled ? 0.5 : 1,
    width: "100%",
    textAlign: "left",
  };
}
