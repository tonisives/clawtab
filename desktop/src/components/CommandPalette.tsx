import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Fuse from "fuse.js";
import type { DetectedProcess, RemoteJob, ShellPane } from "@clawtab/shared";
import { useWorkspaceManager } from "../workspace/WorkspaceManager";
import { requestXtermPaneFocus } from "./XtermPane";

type EntryKind = "agent" | "job" | "shell" | "workspace";

interface PaletteEntry {
  id: string;
  kind: EntryKind;
  workspaceId: string;
  displayName: string;
  cwd: string;
  firstQuery: string;
  lastQuery: string;
  workspaceName: string;
  paneId?: string;
  slug?: string;
  searchFields: {
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
}

function buildEntries(params: {
  jobs: RemoteJob[];
  processes: DetectedProcess[];
  shells: ShellPane[];
  workspaceIds: string[];
  activeId: string;
}): PaletteEntry[] {
  const { jobs, processes, shells, workspaceIds } = params;
  const entries: PaletteEntry[] = [];

  for (const p of processes) {
    const ws = p.matched_group ?? "default";
    const displayName = p.display_name ?? p.cwd.replace(/^\/Users\/[^/]+/, "~");
    const firstQuery = p.first_query ?? "";
    const lastQuery = p.last_query ?? "";
    entries.push({
      id: `agent:${p.pane_id}`,
      kind: "agent",
      workspaceId: ws,
      displayName,
      cwd: p.cwd,
      firstQuery,
      lastQuery,
      workspaceName: ws,
      paneId: p.pane_id,
      searchFields: {
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
    entries.push({
      id: `job:${job.slug}`,
      kind: "job",
      workspaceId: ws,
      displayName: job.name,
      cwd,
      firstQuery: "",
      lastQuery: "",
      workspaceName: ws,
      slug: job.slug,
      searchFields: {
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
    const displayName = s.display_name ?? s.cwd.replace(/^\/Users\/[^/]+/, "~");
    entries.push({
      id: `shell:${s.pane_id}`,
      kind: "shell",
      workspaceId: ws,
      displayName,
      cwd: s.cwd,
      firstQuery: "",
      lastQuery: "",
      workspaceName: ws,
      paneId: s.pane_id,
      searchFields: {
        firstQuery: "",
        lastQuery: "",
        workspaceName: ws,
        cwd: s.cwd,
        displayName,
      },
    });
  }

  for (const id of workspaceIds) {
    entries.push({
      id: `workspace:${id}`,
      kind: "workspace",
      workspaceId: id,
      displayName: id,
      cwd: "",
      firstQuery: "",
      lastQuery: "",
      workspaceName: id,
      searchFields: {
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
}: CommandPaletteProps) {
  const mgr = useWorkspaceManager();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
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
    });
  }, [open, jobs, processes, shells, mgr.ids, mgr.activeId]);

  const fuse = useMemo(() => {
    return new Fuse(entries, {
      keys: [
        { name: "searchFields.firstQuery", weight: 0.3 },
        { name: "searchFields.lastQuery", weight: 0.3 },
        { name: "searchFields.workspaceName", weight: 0.2 },
        { name: "searchFields.cwd", weight: 0.12 },
        { name: "searchFields.displayName", weight: 0.08 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: true,
    });
  }, [entries]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return entries.slice(0, 50);
    return fuse.search(trimmed).slice(0, 50).map((r) => r.item);
  }, [fuse, query, entries]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
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
      className="confirm-overlay"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      style={{ alignItems: "flex-start", paddingTop: "12vh" }}
    >
      <div className="confirm-dialog" style={{ width: 560, maxWidth: "90vw", padding: 0 }}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search agents, jobs, workspaces, shells..."
          className="input"
          style={{ width: "100%", fontSize: 14, border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, padding: "12px 14px", background: "transparent" }}
        />
        <div ref={listRef} style={{ maxHeight: 400, overflowY: "auto" }}>
          {results.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              {query.trim() ? `No results for "${query}"` : "Type to search"}
            </div>
          )}
          {results.map((entry, i) => (
            <div
              key={entry.id}
              data-index={i}
              onClick={() => activate(entry)}
              onMouseEnter={() => setActiveIndex(i)}
              style={{
                padding: "8px 14px",
                cursor: "pointer",
                background: i === activeIndex ? "var(--bg-hover)" : "transparent",
                borderLeft: i === activeIndex ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", minWidth: 68 }}>
                  {entry.workspaceName}
                </span>
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--bg-secondary)", color: "var(--text-muted)" }}>
                  {entry.kind}
                </span>
                <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                  {entry.displayName}
                </span>
              </div>
              {entry.cwd && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", paddingLeft: 76 }}>
                  {entry.cwd}
                </div>
              )}
              {entry.lastQuery && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 76, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {entry.lastQuery}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
