import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { SplitNode } from "../../types/splitTree";
import {
  collectLeaves,
  dedupeIds,
  findDuplicateIds,
  findDuplicateLeafContents,
  restoreIdCounter,
} from "../../util/splitTree";
import { contentKey, loadFocusedLeaf, loadTree, saveFocusedLeaf, saveTree } from "./helpers";
import type { UseSplitTreeControlled } from "./types";

/** Owns the splitTree + focusedLeafId state. Persists to storageKey or routes
 *  through controlled.onChange. Heals duplicate ids. Wraps setSplitTree with a
 *  validating setter that logs which call site produced corrupt trees. */
export function useTreePersistence(opts: {
  storageKey?: string;
  controlledRef: MutableRefObject<UseSplitTreeControlled | undefined>;
  lastSyncedTreeRef: MutableRefObject<SplitNode | null>;
  lastSyncedFocusRef: MutableRefObject<string | null>;
}) {
  const { storageKey, controlledRef, lastSyncedTreeRef, lastSyncedFocusRef } = opts;

  const [splitTree, setSplitTree] = useState<SplitNode | null>(() => {
    const controlled = controlledRef.current;
    if (controlled) {
      if (controlled.tree) restoreIdCounter(controlled.tree);
      return controlled.tree;
    }
    return loadTree(storageKey!, restoreIdCounter, dedupeIds);
  });

  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(() => {
    const controlled = controlledRef.current;
    if (controlled) return controlled.focusedLeafId;
    const saved = loadFocusedLeaf(storageKey!);
    if (!saved) return null;
    const tree = loadTree(storageKey!, restoreIdCounter, dedupeIds);
    if (!tree) return null;
    return collectLeaves(tree).some(l => l.id === saved) ? saved : null;
  });

  const splitTreeRef = useRef(splitTree);
  splitTreeRef.current = splitTree;

  // Persist tree on change. Heals duplicate ids before persisting.
  useEffect(() => {
    if (splitTree) {
      const dupes = findDuplicateIds(splitTree);
      if (dupes.length > 0) {
        console.error("[splitTree] duplicate ids detected, healing:", dupes, splitTree);
        const healed = dedupeIds(splitTree);
        if (healed !== splitTree) {
          setSplitTree(healed);
          return;
        }
      }
      const dupeContents = findDuplicateLeafContents(splitTree);
      if (dupeContents.length > 0) {
        console.error("[splitTree] duplicate leaf contents detected:", dupeContents, splitTree);
      }
    }
    if (controlledRef.current) {
      // Skip if the current internal tree is the same one we just received
      // from controlled (i.e. set by useControlledSync). Otherwise persist
      // and sync round-trip in a loop, since the controlled value lags by
      // one render: we'd push internal back as a "change" and the next sync
      // would clobber it again.
      if (splitTree === lastSyncedTreeRef.current) return;
      if (splitTree !== controlledRef.current.tree) {
        controlledRef.current.onChange({ tree: splitTree });
      }
    } else if (storageKey) {
      saveTree(storageKey, splitTree);
    }
  }, [storageKey, splitTree, controlledRef, lastSyncedTreeRef]);

  // Persist focused leaf on change.
  useEffect(() => {
    if (controlledRef.current) {
      if (focusedLeafId === lastSyncedFocusRef.current) return;
      if (focusedLeafId !== controlledRef.current.focusedLeafId) {
        controlledRef.current.onChange({ focusedLeafId });
      }
    } else if (storageKey) {
      saveFocusedLeaf(storageKey, focusedLeafId);
    }
  }, [storageKey, focusedLeafId, controlledRef, lastSyncedFocusRef]);

  const setSplitTreeChecked = useCallback(
    (updater: SplitNode | null | ((prev: SplitNode | null) => SplitNode | null), site: string) => {
      setSplitTree((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (next !== prev) {
          const summarize = (n: SplitNode | null) => n ? collectLeaves(n).map(l => `${l.id}:${contentKey(l.content)}`).join(",") : "null";
          console.log(`[splitTree] ${site}: ${summarize(prev)} -> ${summarize(next)}`);
        }
        if (next) {
          const dupes = findDuplicateIds(next);
          if (dupes.length > 0) {
            console.error(`[splitTree] ${site} produced duplicate ids:`, dupes, { prev, next });
          }
          const dupeContents = findDuplicateLeafContents(next);
          if (dupeContents.length > 0) {
            console.error(`[splitTree] ${site} produced duplicate leaf contents:`, dupeContents, { prev, next });
          }
        }
        return next;
      });
    },
    [],
  );

  return {
    splitTree,
    setSplitTree,
    setSplitTreeChecked,
    splitTreeRef,
    focusedLeafId,
    setFocusedLeafId,
  };
}
