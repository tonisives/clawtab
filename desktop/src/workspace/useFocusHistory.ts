import { useCallback, useEffect, useRef } from "react";
import { collectLeaves, leafContentKey } from "@clawtab/shared";
import { useWorkspaceManager } from "./WorkspaceManager";
import { FOCUS_HISTORY_KEY, type FocusHistoryEntry, type WorkspaceId } from "./types";

const MAX_HISTORY = 100;

interface Stack {
  entries: FocusHistoryEntry[];
  index: number;
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
  const lastPushedKeyRef = useRef<string>("");
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
    const stackKey = `${mgr.activeId}|${leafId ?? ""}|${contentKey}`;
    if (stackKey === lastPushedKeyRef.current) return;
    lastPushedKeyRef.current = stackKey;

    const entry: FocusHistoryEntry = {
      workspaceId: mgr.activeId,
      leafId,
      contentKey,
      ts: Date.now(),
    };
    const stack = stackRef.current;
    const truncated = stack.entries.slice(0, stack.index + 1);
    truncated.push(entry);
    const trimmed = truncated.length > MAX_HISTORY
      ? truncated.slice(truncated.length - MAX_HISTORY)
      : truncated;
    stackRef.current = { entries: trimmed, index: trimmed.length - 1 };
    saveStack(stackRef.current);
  }, [mgr.activeId, activeFocusedLeafId, currentContentKey, mgr]);

  const isEntryValid = useCallback((entry: FocusHistoryEntry): boolean => {
    const ws = mgr.getState(entry.workspaceId);
    if (entry.leafId == null) {
      if (!ws.singlePaneContent) return false;
      return leafContentKey(ws.singlePaneContent) === entry.contentKey;
    }
    if (!ws.tree) return false;
    const leaf = collectLeaves(ws.tree).find((l) => l.id === entry.leafId);
    if (!leaf) return false;
    return leafContentKey(leaf.content) === entry.contentKey;
  }, [mgr]);

  const applyEntry = useCallback((entry: FocusHistoryEntry): void => {
    suppressNextPushRef.current = true;
    if (entry.workspaceId !== mgr.activeId) {
      mgr.ensure(entry.workspaceId);
      mgr.setActive(entry.workspaceId);
    }
    mgr.updateState(entry.workspaceId, { focusedLeafId: entry.leafId });
    lastPushedKeyRef.current = `${entry.workspaceId}|${entry.leafId ?? ""}|${entry.contentKey}`;
  }, [mgr]);

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
