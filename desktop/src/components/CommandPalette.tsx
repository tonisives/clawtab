import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Fuse from "fuse.js";
import { invoke } from "@tauri-apps/api/core";
import type { DetectedProcess, RemoteJob, ShellPane } from "@clawtab/shared";
import { useWorkspaceManager } from "../workspace/WorkspaceManager";
import { requestXtermPaneFocus } from "./XtermPane";

type EntryKind = "agent" | "job" | "shell" | "workspace" | "view";
type Tab = "panes" | "history";

export type PaletteViewId =
  | "jobs"
  | "mindmap"
  | "secrets"
  | "skills"
  | "usage"
  | "settings"
  | "settings:general"
  | "settings:remote"
  | "settings:telegram"
  | "settings:shortcuts"
  | "settings:models"
  | "settings:daemon";

const VIEW_ENTRIES: { id: PaletteViewId; label: string; group: string }[] = [
  { id: "jobs", label: "Jobs", group: "View" },
  { id: "mindmap", label: "Mind Map", group: "View" },
  { id: "secrets", label: "Secrets", group: "View" },
  { id: "skills", label: "Skills", group: "View" },
  { id: "usage", label: "Usage", group: "View" },
  { id: "settings", label: "Settings", group: "View" },
  { id: "settings:general", label: "Settings - General", group: "Settings" },
  { id: "settings:remote", label: "Settings - Remote", group: "Settings" },
  { id: "settings:telegram", label: "Settings - Telegram", group: "Settings" },
  { id: "settings:shortcuts", label: "Settings - Shortcuts", group: "Settings" },
  { id: "settings:models", label: "Settings - Models", group: "Settings" },
  { id: "settings:daemon", label: "Settings - Daemon", group: "Settings" },
];

const RECENCY_KEY = "clawtab.cmdp.recency.v1";

function loadRecency(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RECENCY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function saveRecency(map: Record<string, number>) {
  try {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 200);
    localStorage.setItem(RECENCY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore
  }
}

interface PaletteEntry {
  id: string;
  kind: EntryKind;
  workspaceId: string;
  displayName: string;
  cwd: string;
  firstQuery: string;
  lastQuery: string;
  paneTitle: string;
  workspaceName: string;
  paneId?: string;
  slug?: string;
  viewId?: PaletteViewId;
  recencyMs: number;
  searchFields: {
    paneTitle: string;
    firstQuery: string;
    lastQuery: string;
    workspaceName: string;
    cwd: string;
    displayName: string;
  };
}

interface HistoryHit {
  session_id: string;
  project_dir: string;
  cwd: string;
  first_user_message: string;
  match_snippet: string | null;
  mtime_ms: number;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  jobs: RemoteJob[];
  processes: DetectedProcess[];
  shells: ShellPane[];
  onSelectJob: (slug: string) => void;
  onSelectProcess: (paneId: string) => void;
  onSelectShell: (paneId: string) => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onResumeSession?: (sessionId: string, cwd: string) => void;
  onSelectView?: (viewId: PaletteViewId) => void;
}

function buildEntries(params: {
  jobs: RemoteJob[];
  processes: DetectedProcess[];
  shells: ShellPane[];
  workspaceIds: string[];
  activeId: string;
  recency: Record<string, number>;
}): PaletteEntry[] {
  const { jobs, processes, shells, workspaceIds, recency } = params;
  const entries: PaletteEntry[] = [];

  for (const p of processes) {
    const ws = p.matched_group ?? "default";
    const displayName = p.display_name ?? p.pane_title ?? p.cwd.replace(/^\/Users\/[^/]+/, "~");
    const firstQuery = p.first_query ?? "";
    const lastQuery = p.last_query ?? "";
    const paneTitle = p.pane_title ?? "";
    const id = `agent:${p.pane_id}`;
    const startedMs = p.session_started_at ? Date.parse(p.session_started_at) : 0;
    const recencyMs = Math.max(
      recency[id] ?? 0,
      p._last_log_change ?? 0,
      Number.isFinite(startedMs) ? startedMs : 0,
    );
    entries.push({
      id,
      kind: "agent",
      workspaceId: ws,
      displayName,
      cwd: p.cwd,
      firstQuery,
      lastQuery,
      paneTitle,
      workspaceName: ws,
      paneId: p.pane_id,
      recencyMs,
      searchFields: {
        paneTitle,
        firstQuery,
        lastQuery,
        workspaceName: ws,
        cwd: p.cwd,
        displayName,
      },
    });
  }

  for (const job of jobs) {
    const ws = job.group || "default";
    const cwd = job.folder_path ?? job.work_dir ?? "";
    const id = `job:${job.slug}`;
    entries.push({
      id,
      kind: "job",
      workspaceId: ws,
      displayName: job.name,
      cwd,
      firstQuery: "",
      lastQuery: "",
      paneTitle: "",
      workspaceName: ws,
      slug: job.slug,
      recencyMs: recency[id] ?? 0,
      searchFields: {
        paneTitle: "",
        firstQuery: "",
        lastQuery: "",
        workspaceName: ws,
        cwd,
        displayName: job.name,
      },
    });
  }

  for (const s of shells) {
    const ws = s.workspace_id ?? s.matched_group ?? "default";
    const displayName = s.display_name ?? s.pane_title ?? s.cwd.replace(/^\/Users\/[^/]+/, "~");
    const paneTitle = s.pane_title ?? "";
    const id = `shell:${s.pane_id}`;
    entries.push({
      id,
      kind: "shell",
      workspaceId: ws,
      displayName,
      cwd: s.cwd,
      firstQuery: "",
      lastQuery: "",
      paneTitle,
      workspaceName: ws,
      paneId: s.pane_id,
      recencyMs: recency[id] ?? 0,
      searchFields: {
        paneTitle,
        firstQuery: "",
        lastQuery: "",
        workspaceName: ws,
        cwd: s.cwd,
        displayName,
      },
    });
  }

  for (const id of workspaceIds) {
    const entryId = `workspace:${id}`;
    entries.push({
      id: entryId,
      kind: "workspace",
      workspaceId: id,
      displayName: id,
      cwd: "",
      firstQuery: "",
      lastQuery: "",
      paneTitle: "",
      workspaceName: id,
      recencyMs: recency[entryId] ?? 0,
      searchFields: {
        paneTitle: "",
        firstQuery: "",
        lastQuery: "",
        workspaceName: id,
        cwd: "",
        displayName: id,
      },
    });
  }

  for (const view of VIEW_ENTRIES) {
    const entryId = `view:${view.id}`;
    entries.push({
      id: entryId,
      kind: "view",
      workspaceId: "",
      displayName: view.label,
      cwd: "",
      firstQuery: "",
      lastQuery: "",
      paneTitle: "",
      workspaceName: view.group,
      viewId: view.id,
      recencyMs: recency[entryId] ?? 0,
      searchFields: {
        paneTitle: view.label,
        firstQuery: "",
        lastQuery: "",
        workspaceName: view.group,
        cwd: "",
        displayName: view.label,
      },
    });
  }

  return entries;
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const lower = text.toLowerCase();
  const q = query.trim().toLowerCase();
  const parts: React.ReactNode[] = [];
  let pos = 0;
  let idx = lower.indexOf(q, pos);
  while (idx !== -1) {
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push(
      <mark key={idx} style={{ background: "var(--accent-color)", color: "var(--bg-secondary)", borderRadius: 2, padding: "0 1px" }}>
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    pos = idx + q.length;
    idx = lower.indexOf(q, pos);
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts.length > 0 ? <>{parts}</> : text;
}

function cwdBasename(cwd: string): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function CommandPalette({
  open,
  onClose,
  jobs,
  processes,
  shells,
  onSelectJob,
  onSelectProcess,
  onSelectShell,
  onSelectWorkspace,
  onResumeSession,
  onSelectView,
}: CommandPaletteProps) {
  const mgr = useWorkspaceManager();
  const [tab, setTab] = useState<Tab>("panes");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recencyMap, setRecencyMap] = useState<Record<string, number>>(() => loadRecency());
  const [historyHits, setHistoryHits] = useState<HistoryHit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const historyReqIdRef = useRef(0);

  const entries = useMemo(() => {
    if (!open) return [];
    return buildEntries({
      jobs,
      processes,
      shells,
      workspaceIds: mgr.ids,
      activeId: mgr.activeId,
      recency: recencyMap,
    });
  }, [open, jobs, processes, shells, mgr.ids, mgr.activeId, recencyMap]);

  const fuse = useMemo(() => {
    return new Fuse(entries, {
      keys: [
        { name: "searchFields.paneTitle", weight: 0.35 },
        { name: "searchFields.firstQuery", weight: 0.2 },
        { name: "searchFields.lastQuery", weight: 0.2 },
        { name: "searchFields.workspaceName", weight: 0.12 },
        { name: "searchFields.cwd", weight: 0.08 },
        { name: "searchFields.displayName", weight: 0.05 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: true,
    });
  }, [entries]);

  const paneResults = useMemo(() => {
    const trimmed = query.trim();
    const now = Date.now();
    const recencyBoost = (ms: number) => {
      if (!ms) return 0;
      const ageHrs = Math.max(0, (now - ms) / 3_600_000);
      return Math.exp(-ageHrs / 8);
    };
    if (!trimmed) {
      return [...entries]
        .sort((a, b) => (b.recencyMs - a.recencyMs))
        .slice(0, 50);
    }
    const scored = fuse.search(trimmed).map((r) => ({
      item: r.item,
      score: (r.score ?? 1) - 0.15 * recencyBoost(r.item.recencyMs),
    }));
    scored.sort((a, b) => a.score - b.score);
    const ranked = scored.slice(0, 50).map((r) => r.item);

    // Pin workspaces whose name contains the query (case-insensitive substring).
    const lower = trimmed.toLowerCase();
    const pinnedIds = new Set<string>();
    const pinned: PaletteEntry[] = [];
    for (const e of entries) {
      if (e.kind !== "workspace") continue;
      if (!e.workspaceName.toLowerCase().includes(lower)) continue;
      pinned.push(e);
      pinnedIds.add(e.id);
    }
    pinned.sort((a, b) => b.recencyMs - a.recencyMs);
    if (pinned.length === 0) return ranked;
    const rest = ranked.filter((e) => !pinnedIds.has(e.id));
    return [...pinned, ...rest].slice(0, 50);
  }, [fuse, query, entries]);

  // Fetch history when on history tab. Debounce query input.
  useEffect(() => {
    if (!open || tab !== "history") return;
    const reqId = ++historyReqIdRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    const timer = window.setTimeout(async () => {
      try {
        const hits = await invoke<HistoryHit[]>("search_claude_history", {
          query,
          limit: 100,
        });
        if (historyReqIdRef.current !== reqId) return;
        setHistoryHits(hits);
        setHistoryLoading(false);
      } catch (e) {
        if (historyReqIdRef.current !== reqId) return;
        setHistoryError(String(e));
        setHistoryHits([]);
        setHistoryLoading(false);
      }
    }, query.trim() ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [open, tab, query]);

  const resultCount = tab === "panes" ? paneResults.length : historyHits.length;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTab("panes");
    setActiveIndex(0);
    setRecencyMap(loadRecency());
    setHistoryHits([]);
    setHistoryError(null);
    setCopiedId(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, tab]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const activatePane = (entry: PaletteEntry) => {
    const next = { ...recencyMap, [entry.id]: Date.now() };
    setRecencyMap(next);
    saveRecency(next);
    if (entry.kind === "view" && entry.viewId) {
      onSelectView?.(entry.viewId);
      onClose();
      return;
    }
    mgr.ensure(entry.workspaceId);
    if (entry.workspaceId !== mgr.activeId) mgr.setActive(entry.workspaceId);
    if (entry.kind === "agent" && entry.paneId) {
      onSelectProcess(entry.paneId);
      requestXtermPaneFocus(entry.paneId);
    } else if (entry.kind === "shell" && entry.paneId) {
      onSelectShell(entry.paneId);
      requestXtermPaneFocus(entry.paneId);
    } else if (entry.kind === "job" && entry.slug) {
      onSelectJob(entry.slug);
    } else if (entry.kind === "workspace") {
      onSelectWorkspace?.(entry.workspaceId);
    }
    onClose();
  };

  const openHistoryHit = (hit: HistoryHit) => {
    if (!onResumeSession) return;
    onResumeSession(hit.session_id, hit.cwd);
    onClose();
  };

  const copyHistoryId = async (hit: HistoryHit) => {
    try {
      await navigator.clipboard.writeText(hit.session_id);
      setCopiedId(hit.session_id);
      window.setTimeout(() => {
        setCopiedId((id) => (id === hit.session_id ? null : id));
      }, 1200);
    } catch (e) {
      console.error("clipboard write failed:", e);
    }
  };

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setTab((t) => (t === "panes" ? "history" : "panes"));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(resultCount - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (tab === "panes") {
        const entry = paneResults[activeIndex];
        if (entry) activatePane(entry);
      } else {
        const hit = historyHits[activeIndex];
        if (hit) openHistoryHit(hit);
      }
    } else if (tab === "history" && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const hit = historyHits[activeIndex];
      if (hit) void copyHistoryId(hit);
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 50000,
      }}
    >
      <div
        style={{
          background: "var(--bg-secondary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2)",
          width: 620,
          maxWidth: "90vw",
          padding: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4, padding: "8px 10px 0 10px" }}>
          {(["panes", "history"] as Tab[]).map((t) => {
            const active = t === tab;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: active ? "var(--accent-color)" : "var(--text-muted, #8e8e93)",
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "4px 10px 6px",
                  borderBottom: active ? "2px solid var(--accent-color)" : "2px solid transparent",
                  cursor: "pointer",
                  fontWeight: active ? 600 : 500,
                }}
              >
                {t === "panes" ? "Panes" : "History"}
              </button>
            );
          })}
          <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted, #8e8e93)", alignSelf: "flex-end", paddingBottom: 6 }}>
            Tab to switch
          </div>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            tab === "panes"
              ? "Search agents, jobs, workspaces, shells..."
              : "Search Claude session history..."
          }
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{
            width: "100%",
            fontSize: 14,
            border: "none",
            borderBottom: "1px solid var(--border-color, #2a2a2a)",
            borderRadius: 0,
            padding: "10px 14px",
            background: "transparent",
            color: "var(--text-primary)",
            outline: "none",
            boxShadow: "none",
          }}
        />
        <div ref={listRef} style={{ maxHeight: 440, overflowY: "auto" }}>
          {tab === "panes" ? (
            paneResults.length === 0 ? (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
                {query.trim() ? `No results for "${query}"` : "Type to search"}
              </div>
            ) : (
              paneResults.map((entry, i) => {
                const isActive = i === activeIndex;
                return (
                  <div
                    key={entry.id}
                    data-index={i}
                    onClick={() => activatePane(entry)}
                    onMouseEnter={() => setActiveIndex(i)}
                    style={{
                      padding: "8px 14px",
                      cursor: "pointer",
                      background: isActive ? "var(--accent-hover)" : "transparent",
                      borderLeft: isActive ? "3px solid var(--accent-color)" : "3px solid transparent",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted, #8e8e93)", minWidth: 68 }}>
                        {entry.workspaceName}
                      </span>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--border-color)", color: "var(--text-muted, #8e8e93)" }}>
                        {entry.kind}
                      </span>
                      <span style={{ fontSize: 13, color: isActive ? "var(--accent-color)" : "var(--text-primary)", fontWeight: isActive ? 600 : 500 }}>
                        {entry.displayName}
                      </span>
                    </div>
                    {entry.cwd && (
                      <div style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)", fontFamily: "monospace", paddingLeft: 76 }}>
                        {entry.cwd}
                      </div>
                    )}
                    {entry.paneTitle && entry.paneTitle !== entry.displayName && (
                      <div style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)", paddingLeft: 76, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.paneTitle}
                      </div>
                    )}
                    {entry.lastQuery && (
                      <div style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)", paddingLeft: 76, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {entry.lastQuery}
                      </div>
                    )}
                  </div>
                );
              })
            )
          ) : historyError ? (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              {historyError}
            </div>
          ) : historyLoading && historyHits.length === 0 ? (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              Searching...
            </div>
          ) : historyHits.length === 0 ? (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              {query.trim() ? `No sessions match "${query}"` : "No sessions found"}
            </div>
          ) : (
            historyHits.map((hit, i) => {
              const isActive = i === activeIndex;
              const baseName = cwdBasename(hit.cwd) || hit.project_dir;
              const rel = formatRelativeTime(hit.mtime_ms);
              const wasCopied = copiedId === hit.session_id;
              // Show match snippet when searching (highlighted), otherwise show first user message.
              const descText = hit.match_snippet || hit.first_user_message;
              return (
                <div
                  key={hit.session_id}
                  data-index={i}
                  onClick={() => openHistoryHit(hit)}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    padding: "8px 14px",
                    cursor: "pointer",
                    background: isActive ? "var(--accent-hover)" : "transparent",
                    borderLeft: isActive ? "3px solid var(--accent-color)" : "3px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted, #8e8e93)", minWidth: 68, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {baseName}
                    </span>
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--border-color)", color: "var(--text-muted, #8e8e93)" }}>
                      session
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)" }}>
                      {rel}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); void copyHistoryId(hit); }}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: wasCopied ? "var(--accent-color)" : "var(--text-primary)",
                          cursor: "pointer",
                        }}
                      >
                        {wasCopied ? "Copied!" : "Copy ID"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); openHistoryHit(hit); }}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--accent-color)",
                          background: isActive ? "var(--accent-color)" : "transparent",
                          color: isActive ? "var(--bg-secondary)" : "var(--accent-color)",
                          cursor: "pointer",
                        }}
                      >
                        Open
                      </button>
                    </span>
                  </div>
                  {hit.cwd && (
                    <div style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)", fontFamily: "monospace", paddingLeft: 76, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {hit.cwd}
                    </div>
                  )}
                  {descText && (
                    <div style={{ fontSize: 11, color: "var(--text-muted, #8e8e93)", paddingLeft: 76, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {highlightQuery(descText, query)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {tab === "history" && (
          <div style={{ padding: "6px 14px", borderTop: "1px solid var(--border-color, #2a2a2a)", fontSize: 10, color: "var(--text-muted, #8e8e93)", display: "flex", gap: 14 }}>
            <span>Enter: open in new pane</span>
            <span>Cmd+Shift+C: copy session ID</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
