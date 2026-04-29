import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Fuse from "fuse.js";
import type { DetectedProcess, RemoteJob, ShellPane } from "@clawtab/shared";
import { useWorkspaceManager } from "../workspace/WorkspaceManager";
import { requestXtermPaneFocus } from "./XtermPane";

type EntryKind = "agent" | "job" | "shell" | "workspace";

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

  return entries;
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
}: CommandPaletteProps) {
  const mgr = useWorkspaceManager();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recencyMap, setRecencyMap] = useState<Record<string, number>>(() => loadRecency());
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const results = useMemo(() => {
    const trimmed = query.trim();
    const now = Date.now();
    // Recency bonus decays over a 24h window: 1.0 if just used, ~0 after a day.
    const recencyBoost = (ms: number) => {
      if (!ms) return 0;
      const ageHrs = Math.max(0, (now - ms) / 3_600_000);
      return Math.exp(-ageHrs / 8); // half-life ~5.5h, ~0.05 at 24h
    };
    if (!trimmed) {
      return [...entries]
        .sort((a, b) => (b.recencyMs - a.recencyMs))
        .slice(0, 50);
    }
    // Blend Fuse score (lower=better) with recency bonus. Cap bonus at 0.15
    // so a fresh-but-irrelevant pane can't outrank a clearly better text match.
    const scored = fuse.search(trimmed).map((r) => ({
      item: r.item,
      score: (r.score ?? 1) - 0.15 * recencyBoost(r.item.recencyMs),
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 50).map((r) => r.item);
  }, [fuse, query, entries]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setRecencyMap(loadRecency());
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const activate = (entry: PaletteEntry) => {
    const next = { ...recencyMap, [entry.id]: Date.now() };
    setRecencyMap(next);
    saveRecency(next);
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

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = results[activeIndex];
      if (entry) activate(entry);
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
          width: 560,
          maxWidth: "90vw",
          padding: 0,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search agents, jobs, workspaces, shells..."
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
            padding: "12px 14px",
            background: "transparent",
            color: "var(--text-primary)",
            outline: "none",
            boxShadow: "none",
          }}
        />
        <div ref={listRef} style={{ maxHeight: 400, overflowY: "auto" }}>
          {results.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              {query.trim() ? `No results for "${query}"` : "Type to search"}
            </div>
          )}
          {results.map((entry, i) => {
            const isActive = i === activeIndex;
            return (
              <div
                key={entry.id}
                data-index={i}
                onClick={() => activate(entry)}
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
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
