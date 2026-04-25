import { useCallback, useEffect, useRef } from "react";
import { collectLeaves, leafContentKey } from "@clawtab/shared";
import { useWorkspaceManager } from "./WorkspaceManager";
import { FOCUS_HISTORY_KEY, type FocusHistoryEntry, type WorkspaceId } from "./types";

const MAX_HISTORY = 100;

interface Stack {
  entries: FocusHistoryEntry[];
  index: number;
}

function entryKey(workspaceId: WorkspaceId, contentKey: string): string {
  return `${workspaceId}|${contentKey}`;
}

function loadStack(): Stack {
  if (typeof localStorage === "undefined") return { entries: [], index: -1 };
  const raw = localStorage.getItem(FOCUS_HISTORY_KEY);
  if (!raw) return { entries: [], index: -1 };
  try {
    const parsed = JSON.parse(raw) as Stack;
    if (!Array.isArray(parsed.entries) || typeof parsed.index !== "number") return { entries: [], index: -1 };
    return parsed;
  } catch {
    return { entries: [], index: -1 };
  }
}

function saveStack(stack: Stack): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FOCUS_HISTORY_KEY, JSON.stringify(stack));
}

export interface FocusHistoryApi {
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
}

export function useFocusHistory(): FocusHistoryApi {
  const mgr = useWorkspaceManager();
  const stackRef = useRef<Stack>(loadStack());
  const suppressNextPushRef = useRef(false);

  const currentContentKey = useCallback((wsId: WorkspaceId, leafId: string | null): string => {
    const ws = mgr.getState(wsId);
    if (!ws.tree) {
      if (ws.singlePaneContent) return leafContentKey(ws.singlePaneContent);
      return "";
    }
    if (leafId) {
      const leaf = collectLeaves(ws.tree).find((l) => l.id === leafId);
      if (leaf) return leafContentKey(leaf.content);
    }
    return "";
  }, [mgr]);

  const activeFocusedLeafId = mgr.getState(mgr.activeId).focusedLeafId;
  useEffect(() => {
    if (suppressNextPushRef.current) {
      suppressNextPushRef.current = false;
      return;
    }
    const leafId = activeFocusedLeafId;
    const contentKey = currentContentKey(mgr.activeId, leafId);
    if (!contentKey) return;
    const key = entryKey(mgr.activeId, contentKey);
    const stack = stackRef.current;

    const current = stack.index >= 0 ? stack.entries[stack.index] : null;
    if (current && entryKey(current.workspaceId, current.contentKey) === key) return;

    // Drop any forward history (browser-style) and any prior occurrence of the same pane (MRU dedup)
    const truncated = stack.entries
      .slice(0, stack.index + 1)
      .filter((e) => entryKey(e.workspaceId, e.contentKey) !== key);
    truncated.push({ workspaceId: mgr.activeId, leafId, contentKey, ts: Date.now() });
    const trimmed = truncated.length > MAX_HISTORY
      ? truncated.slice(truncated.length - MAX_HISTORY)
      : truncated;
    stackRef.current = { entries: trimmed, index: trimmed.length - 1 };
    saveStack(stackRef.current);
  }, [mgr.activeId, activeFocusedLeafId, currentContentKey, mgr]);

  const resolveLeafId = useCallback((entry: FocusHistoryEntry): string | null | undefined => {
    const ws = mgr.getState(entry.workspaceId);
    if (!ws.tree) {
      if (ws.singlePaneContent && leafContentKey(ws.singlePaneContent) === entry.contentKey) return null;
      return undefined;
    }
    const leaves = collectLeaves(ws.tree);
    // Prefer the original leafId if it still hosts the same content
    if (entry.leafId) {
      const original = leaves.find((l) => l.id === entry.leafId);
      if (original && leafContentKey(original.content) === entry.contentKey) return entry.leafId;
    }
    // Fall back to any leaf with matching content (handles split tree restructuring)
    const match = leaves.find((l) => leafContentKey(l.content) === entry.contentKey);
    return match ? match.id : undefined;
  }, [mgr]);

  const isEntryValid = useCallback((entry: FocusHistoryEntry): boolean => {
    return resolveLeafId(entry) !== undefined;
  }, [resolveLeafId]);

  const applyEntry = useCallback((entry: FocusHistoryEntry): void => {
    const leafId = resolveLeafId(entry);
    if (leafId === undefined) return;
    suppressNextPushRef.current = true;
    if (entry.workspaceId !== mgr.activeId) {
      mgr.ensure(entry.workspaceId);
      mgr.setActive(entry.workspaceId);
    }
    mgr.updateState(entry.workspaceId, { focusedLeafId: leafId });
  }, [mgr, resolveLeafId]);

  const back = useCallback(() => {
    const stack = stackRef.current;
    let idx = stack.index - 1;
    while (idx >= 0 && !isEntryValid(stack.entries[idx])) idx -= 1;
    if (idx < 0) return;
    stackRef.current = { entries: stack.entries, index: idx };
    saveStack(stackRef.current);
    applyEntry(stack.entries[idx]);
  }, [applyEntry, isEntryValid]);

  const forward = useCallback(() => {
    const stack = stackRef.current;
    let idx = stack.index + 1;
    while (idx < stack.entries.length && !isEntryValid(stack.entries[idx])) idx += 1;
    if (idx >= stack.entries.length) return;
    stackRef.current = { entries: stack.entries, index: idx };
    saveStack(stackRef.current);
    applyEntry(stack.entries[idx]);
  }, [applyEntry, isEntryValid]);

  const canBack = useCallback(() => {
    const stack = stackRef.current;
    for (let i = stack.index - 1; i >= 0; i -= 1) {
      if (isEntryValid(stack.entries[i])) return true;
    }
    return false;
  }, [isEntryValid]);

  const canForward = useCallback(() => {
    const stack = stackRef.current;
    for (let i = stack.index + 1; i < stack.entries.length; i += 1) {
      if (isEntryValid(stack.entries[i])) return true;
    }
    return false;
  }, [isEntryValid]);

  return { back, forward, canBack, canForward };
}
