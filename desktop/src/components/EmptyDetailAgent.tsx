import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { JobKindIcon, PopupMenu } from "@clawtab/shared";
import type { ProcessProvider } from "@clawtab/shared";

function labelForProvider(provider: ProcessProvider): string {
  switch (provider) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "shell":
      return "Shell";
  }
}

interface EmptyDetailAgentProps {
  onRunAgent: (prompt: string, workDir?: string, provider?: ProcessProvider) => void | Promise<void>;
  getAgentProviders: () => Promise<ProcessProvider[]>;
  defaultProvider: ProcessProvider;
  focusSignal?: number;
  folderGroups?: { group: string; folderPath: string }[];
}

export function EmptyDetailAgent({ onRunAgent, getAgentProviders, defaultProvider, focusSignal, folderGroups = [] }: EmptyDetailAgentProps) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [provider, setProvider] = useState<ProcessProvider>(defaultProvider);
  const [providers, setProviders] = useState<ProcessProvider[]>([defaultProvider]);
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [folderMenuPos, setFolderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const providerButtonRef = useRef<HTMLButtonElement>(null);
  const folderButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusSignalRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getAgentProviders()
      .then((list) => {
        if (!cancelled) setProviders(list.length > 0 ? list : [defaultProvider]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [defaultProvider, getAgentProviders]);

  useEffect(() => {
    setProvider(defaultProvider);
  }, [defaultProvider]);

  const resolvedProviders = useMemo(() => {
    const list = providers.includes(defaultProvider) ? providers : [defaultProvider, ...providers];
    return list.filter((p, i) => list.indexOf(p) === i);
  }, [providers, defaultProvider]);

  const folderOptions = useMemo(() => {
    const seen = new Set<string>();
    return folderGroups.filter(({ folderPath }) => {
      if (!folderPath || seen.has(folderPath)) return false;
      seen.add(folderPath);
      return true;
    });
  }, [folderGroups]);

  const selectedFolder = useMemo(() => {
    if (!workDir) return null;
    const match = folderOptions.find((option) => option.folderPath === workDir);
    return {
      group: match?.group ?? workDir.split("/").filter(Boolean).pop() ?? "Folder",
      folderPath: workDir,
      label: match?.group ?? workDir,
    };
  }, [folderOptions, workDir]);

  const handleRun = useCallback(async () => {
    if (!prompt.trim()) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onRunAgent(prompt.trim(), workDir ?? undefined, provider);
      setPrompt("");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [prompt, workDir, provider, onRunAgent]);

  const handleFolderPick = useCallback(async () => {
    setFolderMenuOpen(false);
    const selected = await open({ directory: true, multiple: false, title: "Choose folder" });
    if (selected) {
      const dir = typeof selected === "string" ? selected : (selected as string[])[0];
      setWorkDir(dir?.replace(/\/+$/, "") ?? null);
    }
  }, []);

  const focusTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch {}
  }, []);

  useEffect(() => {
    if (focusSignal === lastFocusSignalRef.current) return;
    lastFocusSignalRef.current = focusSignal;
    if (typeof focusSignal === "number" && focusSignal > 0) {
      requestAnimationFrame(focusTextarea);
    }
  }, [focusSignal, focusTextarea]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleRun();
        return;
      }
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (resolvedProviders.length <= 1) return;
        const currentIndex = Math.max(resolvedProviders.indexOf(provider), 0);
        const step = e.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + step + resolvedProviders.length) % resolvedProviders.length;
        setProvider(resolvedProviders[nextIndex]);
        setProviderMenuOpen(false);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [handleRun, provider, resolvedProviders]);

  return (
    <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 420, maxWidth: "90%" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginBottom: 4 }}>
          Run an agent in a folder
        </div>
        <div style={{ position: "relative" }}>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter prompt..."
            disabled={sending}
            style={{
              width: "100%",
              minHeight: 68,
              maxHeight: 240,
              padding: "8px 12px",
              paddingRight: 68,
              borderRadius: 6,
              border: "1px solid var(--border-light)",
              background: "var(--bg-primary, #0a0a0a)",
              color: "var(--text)",
              fontSize: 13,
              lineHeight: 1.4,
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            ref={providerButtonRef}
            onClick={(e) => {
              if (resolvedProviders.length <= 1) return;
              const rect = e.currentTarget.getBoundingClientRect();
              setProviderMenuPos({ top: rect.bottom + 6, left: rect.right });
              setProviderMenuOpen((o) => !o);
            }}
            style={{
              height: 28,
              minWidth: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              paddingLeft: 6,
              paddingRight: resolvedProviders.length > 1 ? 7 : 8,
              borderRadius: 999,
              background: "rgba(10, 10, 10, 0.55)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              cursor: resolvedProviders.length > 1 ? "pointer" : "default",
              color: "var(--text)",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            <JobKindIcon kind={provider} size={16} compact bare />
            <span>{labelForProvider(provider)}</span>
            {resolvedProviders.length > 1 && (
              <span style={{ color: "var(--text-muted)", fontSize: 9, marginTop: -1 }}>&#9662;</span>
            )}
          </button>
          <button
            ref={folderButtonRef}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setFolderMenuPos({ top: rect.bottom + 6, left: rect.right });
              setFolderMenuOpen((open) => !open);
            }}
            title={selectedFolder ? selectedFolder.folderPath : "Pick folder"}
            style={{
              height: 28,
              minWidth: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 999,
              background: workDir ? "rgba(121, 134, 203, 0.12)" : "rgba(10, 10, 10, 0.55)",
              border: workDir ? "1px solid rgba(121, 134, 203, 0.25)" : "1px solid rgba(255, 255, 255, 0.08)",
              cursor: "pointer",
              color: workDir ? "var(--accent, #7986cb)" : "var(--text-muted)",
              fontSize: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            ...
          </button>
          {selectedFolder && (
            <span
              style={{
                color: workDir ? "var(--accent, #7986cb)" : "var(--text-muted)",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                maxWidth: 220,
              }}
              title={selectedFolder.folderPath}
            >
              {selectedFolder.label}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => { void handleRun(); }}
            disabled={!prompt.trim() || sending}
            style={{
              height: 28,
              width: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              background: "var(--accent, #7986cb)",
              border: "none",
              cursor: prompt.trim() && !sending ? "pointer" : "default",
              opacity: !prompt.trim() || sending ? 0.5 : 1,
              padding: 0,
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: "6px solid #fff",
                borderTop: "4px solid transparent",
                borderBottom: "4px solid transparent",
                marginLeft: 2,
              }}
            />
          </button>
        </div>
      </div>
      {providerMenuOpen && resolvedProviders.length > 1 && (
        <PopupMenu
          items={resolvedProviders.map((option) => ({
            type: "item" as const,
            label: labelForProvider(option),
            active: option === provider,
            icon: <JobKindIcon kind={option} size={16} compact bare />,
            onPress: () => {
              setProvider(option);
              setProviderMenuOpen(false);
            },
          }))}
          position={providerMenuPos}
          onClose={() => setProviderMenuOpen(false)}
          triggerRef={providerButtonRef as any}
          autoFocus
        />
      )}
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
