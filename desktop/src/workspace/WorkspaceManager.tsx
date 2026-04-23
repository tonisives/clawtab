/*
 * WorkspaceManager - per-group split tree state.
 *
 * Invariants:
 *   1. A given paneId appears in at most one workspace tree at a time.
 *   2. A given job slug / agent content appears in at most one workspace tree.
 *   3. The active workspace's focusedLeafId references a real leaf or is null.
 *   4. Cross-workspace DnD is a MOVE, never a copy.
 *   5. paneInstances (XtermPane.tsx) survives workspace switches - switching
 *      just reparents the DOM container into the newly-active detail pane.
 *   6. ShellPane.workspace_id is sticky until the shell is closed.
 *
 * Phase 1: scaffold only. Exposes one hard-coded "default" workspace.
 * Full multi-workspace behavior (movePaneTo, replaceContentAnywhere, focus
 * history events, cross-group DnD) is added in later phases.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { PaneContent, SplitNode } from "@clawtab/shared";
import { collectLeaves, genPaneId, leafContentEquals, leafContentKey, replaceNode, removeLeaf } from "@clawtab/shared";
import {
  DEFAULT_WORKSPACE_ID,
  WS_INDEX_KEY,
  emptyWorkspaceState,
  wsKey,
  type WorkspaceId,
  type WorkspaceIndex,
  type WorkspaceState,
} from "./types";

interface WorkspaceManagerAPI {
  activeId: WorkspaceId;
  ids: WorkspaceId[];
  getState(id: WorkspaceId): WorkspaceState;
  getAllStates(): ReadonlyMap<WorkspaceId, WorkspaceState>;
  setActive(id: WorkspaceId): void;
  ensure(id: WorkspaceId): void;
  remove(id: WorkspaceId): void;
  updateActive(patch: Partial<Omit<WorkspaceState, "id">>): void;
  updateState(id: WorkspaceId, patch: Partial<Omit<WorkspaceState, "id">>): void;
  findPane(contentKey: string): { workspaceId: WorkspaceId; leafId: string } | null;
  replaceContentAnywhere(from: PaneContent, to: PaneContent): boolean;
  /** MOVE content from its current workspace tree to the target workspace.
   *  Upholds invariant #1 (paneId in at most one tree) and #4 (cross-ws DnD
   *  is a MOVE, not a copy). */
  movePaneTo(targetWorkspaceId: WorkspaceId, content: PaneContent): void;
}

type Action =
  | { type: "SET_ACTIVE"; id: WorkspaceId }
  | { type: "UPSERT"; state: WorkspaceState }
  | { type: "UPDATE"; id: WorkspaceId; patch: Partial<Omit<WorkspaceState, "id">> }
  | { type: "REMOVE"; id: WorkspaceId }
  | { type: "HYDRATE"; activeId: WorkspaceId; states: Map<WorkspaceId, WorkspaceState> }
  | { type: "REPLACE_CONTENT"; from: PaneContent; to: PaneContent }
  | { type: "MOVE_PANE"; target: WorkspaceId; content: PaneContent };

interface ReducerState {
  activeId: WorkspaceId;
  states: Map<WorkspaceId, WorkspaceState>;
}

function reducer(s: ReducerState, action: Action): ReducerState {
  switch (action.type) {
    case "SET_ACTIVE": {
      if (s.activeId === action.id) return s;
      if (!s.states.has(action.id)) return s;
      return { ...s, activeId: action.id };
    }
    case "UPSERT": {
      if (s.states.has(action.state.id)) return s;
      const next = new Map(s.states);
      next.set(action.state.id, action.state);
      return { ...s, states: next };
    }
    case "UPDATE": {
      const current = s.states.get(action.id);
      if (!current) return s;
      const merged: WorkspaceState = { ...current, ...action.patch };
      if (
        merged.tree === current.tree &&
        merged.focusedLeafId === current.focusedLeafId &&
        merged.singlePaneContent === current.singlePaneContent
      ) {
        return s;
      }
      const next = new Map(s.states);
      next.set(action.id, merged);
      return { ...s, states: next };
    }
    case "REMOVE": {
      if (!s.states.has(action.id)) return s;
      const next = new Map(s.states);
      next.delete(action.id);
      const activeId = s.activeId === action.id
        ? (next.keys().next().value ?? DEFAULT_WORKSPACE_ID)
        : s.activeId;
      if (!next.has(activeId)) next.set(activeId, emptyWorkspaceState(activeId));
      return { activeId, states: next };
    }
    case "HYDRATE": {
      return { activeId: action.activeId, states: action.states };
    }
    case "MOVE_PANE": {
      // Remove `content` from whichever workspace currently owns it, then
      // insert it into `target` as a new split-right or as the root leaf.
      // Upholds invariant #1 (content in at most one tree) atomically.
      const next = new Map(s.states);
      let removedFrom: WorkspaceId | null = null;
      for (const [wsId, current] of s.states) {
        if (!current.tree) continue;
        const match = collectLeaves(current.tree).find((leaf) => leafContentEquals(leaf.content, action.content));
        if (!match) continue;
        const trimmed = removeLeaf(current.tree, match.id);
        next.set(wsId, {
          ...current,
          tree: trimmed,
          focusedLeafId: current.focusedLeafId === match.id ? null : current.focusedLeafId,
        });
        removedFrom = wsId;
        break;
      }

      const targetCurrent = next.get(action.target) ?? emptyWorkspaceState(action.target);
      const newLeafId = genPaneId();
      const newLeaf: SplitNode = { type: "leaf", id: newLeafId, content: action.content };
      let targetTree: SplitNode;
      if (!targetCurrent.tree) {
        targetTree = newLeaf;
      } else {
        const rootLeaves = collectLeaves(targetCurrent.tree);
        const existing = rootLeaves.find((l) => leafContentEquals(l.content, action.content));
        if (existing) {
          // Already present: no-op placement, but make sure focused-leaf points at it.
          next.set(action.target, { ...targetCurrent, focusedLeafId: existing.id });
          if (removedFrom && removedFrom !== action.target) return { ...s, states: next };
          return s;
        }
        // Graft as a rightward horizontal split at the root.
        targetTree = {
          type: "split",
          id: genPaneId(),
          direction: "horizontal",
          ratio: 0.5,
          first: targetCurrent.tree,
          second: newLeaf,
        };
      }

      next.set(action.target, {
        ...targetCurrent,
        tree: targetTree,
        focusedLeafId: newLeafId,
      });
      if (!removedFrom && !s.states.has(action.target)) return s;
      return { ...s, states: next };
    }
    case "REPLACE_CONTENT": {
      // Atomic search-then-replace to survive workspace switch / drag races.
      // If a matching leaf exists in another workspace AND the target content
      // already exists there, remove the source leaf (dedup) instead of
      // replacing, upholding invariant #2.
      for (const [wsId, current] of s.states) {
        if (!current.tree) continue;
        const leaves = collectLeaves(current.tree);
        const match = leaves.find((leaf) => leafContentEquals(leaf.content, action.from));
        if (!match) continue;
        const existingTo = leaves.find((leaf) => leafContentEquals(leaf.content, action.to));
        let nextTree: SplitNode | null;
        if (existingTo && existingTo.id !== match.id) {
          nextTree = removeLeaf(current.tree, match.id);
        } else {
          nextTree = replaceNode(current.tree, match.id, { type: "leaf", id: match.id, content: action.to });
        }
        if (nextTree === current.tree) return s;
        const next = new Map(s.states);
        next.set(wsId, { ...current, tree: nextTree });
        return { ...s, states: next };
      }
      return s;
    }
    default:
      return s;
  }
}

function loadInitial(): ReducerState {
  const seed: ReducerState = {
    activeId: DEFAULT_WORKSPACE_ID,
    states: new Map([[DEFAULT_WORKSPACE_ID, emptyWorkspaceState(DEFAULT_WORKSPACE_ID)]]),
  };
  if (typeof localStorage === "undefined") return seed;

  const indexRaw = localStorage.getItem(WS_INDEX_KEY);
  if (!indexRaw) {
    migrateLegacyIfPresent(seed);
    return seed;
  }
  try {
    const index = JSON.parse(indexRaw) as WorkspaceIndex;
    const states = new Map<WorkspaceId, WorkspaceState>();
    for (const id of index.ids) {
      states.set(id, loadWorkspace(id));
    }
    if (!states.has(index.activeId)) {
      states.set(DEFAULT_WORKSPACE_ID, emptyWorkspaceState(DEFAULT_WORKSPACE_ID));
      return { activeId: DEFAULT_WORKSPACE_ID, states };
    }
    return { activeId: index.activeId, states };
  } catch (err) {
    console.error("[workspace] failed to load index, resetting", err);
    return seed;
  }
}

function loadWorkspace(id: WorkspaceId): WorkspaceState {
  const state = emptyWorkspaceState(id);
  try {
    const treeRaw = localStorage.getItem(wsKey(id, "tree"));
    if (treeRaw) state.tree = JSON.parse(treeRaw) as SplitNode;
    const focused = localStorage.getItem(wsKey(id, "focused"));
    if (focused) state.focusedLeafId = focused;
    const singleRaw = localStorage.getItem(wsKey(id, "single"));
    if (singleRaw) state.singlePaneContent = JSON.parse(singleRaw) as PaneContent;
  } catch (err) {
    console.error(`[workspace] failed to load ws ${id}`, err);
  }
  return state;
}

function migrateLegacyIfPresent(seed: ReducerState): void {
  const legacyTreeRaw = localStorage.getItem("desktop_split_tree");
  const legacyFocused = localStorage.getItem("desktop_split_tree_focused_leaf");
  const legacySingleRaw = localStorage.getItem("desktop_single_pane_content");
  if (!legacyTreeRaw && !legacyFocused && !legacySingleRaw) return;

  const defaultState = seed.states.get(DEFAULT_WORKSPACE_ID)!;
  try {
    if (legacyTreeRaw) defaultState.tree = JSON.parse(legacyTreeRaw) as SplitNode;
    if (legacyFocused) defaultState.focusedLeafId = legacyFocused;
    if (legacySingleRaw) defaultState.singlePaneContent = JSON.parse(legacySingleRaw) as PaneContent;
  } catch (err) {
    console.error("[workspace] legacy migration parse failed", err);
  }

  writeIndex({ version: 2, ids: [DEFAULT_WORKSPACE_ID], activeId: DEFAULT_WORKSPACE_ID });
  writeWorkspace(defaultState);

  localStorage.removeItem("desktop_split_tree");
  localStorage.removeItem("desktop_split_tree_focused_leaf");
  localStorage.removeItem("desktop_single_pane_content");
}

function writeIndex(index: WorkspaceIndex): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(WS_INDEX_KEY, JSON.stringify(index));
}

function writeWorkspace(state: WorkspaceState): void {
  if (typeof localStorage === "undefined") return;
  if (state.tree) localStorage.setItem(wsKey(state.id, "tree"), JSON.stringify(state.tree));
  else localStorage.removeItem(wsKey(state.id, "tree"));
  if (state.focusedLeafId) localStorage.setItem(wsKey(state.id, "focused"), state.focusedLeafId);
  else localStorage.removeItem(wsKey(state.id, "focused"));
  if (state.singlePaneContent) localStorage.setItem(wsKey(state.id, "single"), JSON.stringify(state.singlePaneContent));
  else localStorage.removeItem(wsKey(state.id, "single"));
}

function removeWorkspaceKeys(id: WorkspaceId): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(wsKey(id, "tree"));
  localStorage.removeItem(wsKey(id, "focused"));
  localStorage.removeItem(wsKey(id, "single"));
}

const WorkspaceContext = createContext<WorkspaceManagerAPI | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [reduced, dispatch] = useReducer(reducer, undefined, loadInitial);

  const lastWritten = useRef<{ activeId: WorkspaceId; states: Map<WorkspaceId, WorkspaceState> }>({
    activeId: reduced.activeId,
    states: new Map(reduced.states),
  });

  useEffect(() => {
    const prev = lastWritten.current;

    if (prev.activeId !== reduced.activeId || prev.states.size !== reduced.states.size ||
      [...reduced.states.keys()].some((id) => !prev.states.has(id)) ||
      [...prev.states.keys()].some((id) => !reduced.states.has(id))) {
      writeIndex({
        version: 2,
        ids: [...reduced.states.keys()],
        activeId: reduced.activeId,
      });
    }

    for (const [id, state] of reduced.states) {
      if (prev.states.get(id) !== state) {
        writeWorkspace(state);
      }
    }
    for (const id of prev.states.keys()) {
      if (!reduced.states.has(id)) removeWorkspaceKeys(id);
    }

    lastWritten.current = { activeId: reduced.activeId, states: new Map(reduced.states) };
  }, [reduced]);

  const setActive = useCallback((id: WorkspaceId) => {
    dispatch({ type: "SET_ACTIVE", id });
  }, []);

  const ensure = useCallback((id: WorkspaceId) => {
    dispatch({ type: "UPSERT", state: emptyWorkspaceState(id) });
  }, []);

  const remove = useCallback((id: WorkspaceId) => {
    if (id === DEFAULT_WORKSPACE_ID) return;
    dispatch({ type: "REMOVE", id });
  }, []);

  const updateState = useCallback((id: WorkspaceId, patch: Partial<Omit<WorkspaceState, "id">>) => {
    dispatch({ type: "UPDATE", id, patch });
  }, []);

  const updateActive = useCallback((patch: Partial<Omit<WorkspaceState, "id">>) => {
    dispatch({ type: "UPDATE", id: reduced.activeId, patch });
  }, [reduced.activeId]);

  const getState = useCallback((id: WorkspaceId): WorkspaceState => {
    return reduced.states.get(id) ?? emptyWorkspaceState(id);
  }, [reduced]);

  const getAllStates = useCallback((): ReadonlyMap<WorkspaceId, WorkspaceState> => {
    return reduced.states;
  }, [reduced]);

  const findPane = useCallback((contentKey: string): { workspaceId: WorkspaceId; leafId: string } | null => {
    for (const [wsId, state] of reduced.states) {
      if (!state.tree) continue;
      for (const leaf of collectLeaves(state.tree)) {
        if (leafContentKey(leaf.content) === contentKey) {
          return { workspaceId: wsId, leafId: leaf.id };
        }
      }
    }
    return null;
  }, [reduced]);

  const movePaneTo = useCallback((target: WorkspaceId, content: PaneContent): void => {
    dispatch({ type: "MOVE_PANE", target, content });
  }, []);

  const replaceContentAnywhere = useCallback((from: PaneContent, to: PaneContent): boolean => {
    // Best-effort pre-check so callers get a return value; the real work
    // happens inside the reducer under REPLACE_CONTENT, which re-scans current
    // state to survive concurrent mutations (e.g. cross-workspace drag racing
    // with promote/demote).
    let found = false;
    for (const state of reduced.states.values()) {
      if (!state.tree) continue;
      if (collectLeaves(state.tree).some((leaf) => leafContentEquals(leaf.content, from))) {
        found = true;
        break;
      }
    }
    dispatch({ type: "REPLACE_CONTENT", from, to });
    return found;
  }, [reduced]);

  const api = useMemo<WorkspaceManagerAPI>(() => ({
    activeId: reduced.activeId,
    ids: [...reduced.states.keys()],
    getState,
    getAllStates,
    setActive,
    ensure,
    remove,
    updateActive,
    updateState,
    findPane,
    replaceContentAnywhere,
    movePaneTo,
  }), [reduced, getState, getAllStates, setActive, ensure, remove, updateActive, updateState, findPane, replaceContentAnywhere, movePaneTo]);

  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceManager(): WorkspaceManagerAPI {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspaceManager must be used inside WorkspaceProvider");
  return ctx;
}

export function useActiveWorkspace(): WorkspaceState {
  const mgr = useWorkspaceManager();
  return mgr.getState(mgr.activeId);
}
