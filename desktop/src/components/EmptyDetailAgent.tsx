import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { JobKindIcon, PopupMenu } from "@clawtab/shared";
import type { ProcessProvider } from "@clawtab/shared";
import {
  buildModelOptions,
  labelForProviderModel,
  type ModelOption,
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
}

const LINE_HEIGHT = 18;
const VERTICAL_PADDING = 16;
const EXPANDED_MAX_HEIGHT = 400;

export function EmptyDetailAgent({ onRunAgent, getAgentProviders, defaultProvider, defaultModel, enabledModels = {}, focusSignal, folderGroups = [] }: EmptyDetailAgentProps) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [provider, setProvider] = useState<ProcessProvider>(defaultProvider);
  const [model, setModel] = useState<string | null>(defaultModel ?? null);
  const [providers, setProviders] = useState<ProcessProvider[]>([defaultProvider]);
  const [workDir, setWorkDirState] = useState<string | null>(() => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(LAST_RUN_AGENT_FOLDER_KEY);
  });
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [folderMenuPos, setFolderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const providerButtonRef = useRef<HTMLButtonElement>(null);
  const folderButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
    setModel(defaultModel ?? null);
  }, [defaultProvider, defaultModel]);

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

  const handleRun = useCallback(async () => {
    if (!prompt.trim()) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onRunAgent(prompt.trim(), workDir ?? undefined, provider, model ?? undefined);
      setPrompt("");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [prompt, workDir, provider, model, onRunAgent]);

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

  const handleRunRef = useRef(handleRun);
  useEffect(() => { handleRunRef.current = handleRun; }, [handleRun]);
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);
  const modelOptionsRef = useRef(modelOptions);
  useEffect(() => { modelOptionsRef.current = modelOptions; }, [modelOptions]);

  const selectModelOption = useCallback((opt: ModelOption) => {
    setProvider(opt.provider);
    setModel(opt.modelId);
    setProviderMenuOpen(false);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleRunRef.current();
        return;
      }
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const opts = modelOptionsRef.current;
        if (opts.length <= 1) return;
        const currentIndex = Math.max(
          opts.findIndex((o) => o.provider === providerRef.current && o.modelId === modelRef.current),
          0,
        );
        const step = e.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + step + opts.length) % opts.length;
        const next = opts[nextIndex];
        setProvider(next.provider);
        setModel(next.modelId);
        setProviderMenuOpen(false);
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, []);

  const MIN_LINES = 5;
  const lineCount = Math.max(prompt.split("\n").length, MIN_LINES);
  const textareaHeight = Math.min(
    lineCount * LINE_HEIGHT + VERTICAL_PADDING,
    EXPANDED_MAX_HEIGHT,
  );

  return (
    <div ref={rootRef} tabIndex={-1} style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "90%" }}>
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
              height: textareaHeight,
              minHeight: LINE_HEIGHT + VERTICAL_PADDING,
              maxHeight: EXPANDED_MAX_HEIGHT,
              padding: "8px 12px",
              paddingRight: 68,
              borderRadius: 6,
              border: "1px solid var(--border-light)",
              background: "var(--bg-primary, #0a0a0a)",
              color: "var(--text)",
              fontSize: 13,
              lineHeight: `${LINE_HEIGHT}px`,
              resize: "none",
              overflow: "auto",
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
              if (modelOptions.length <= 1) return;
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
              paddingRight: modelOptions.length > 1 ? 7 : 8,
              borderRadius: 999,
              background: "rgba(10, 10, 10, 0.55)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              cursor: modelOptions.length > 1 ? "pointer" : "default",
              color: "var(--text)",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            <JobKindIcon kind={provider} size={16} compact bare />
            <span>{labelForProviderModel(provider, model)}</span>
            {modelOptions.length > 1 && (
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
      {providerMenuOpen && modelOptions.length > 1 && (
        <PopupMenu
          items={modelOptions.map((opt) => ({
            type: "item" as const,
            label: opt.label,
            active: opt.provider === provider && opt.modelId === model,
            icon: <JobKindIcon kind={opt.provider} size={16} compact bare />,
            onPress: () => selectModelOption(opt),
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
