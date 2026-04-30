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
}) {
  const { storageKey, controlledRef } = opts;

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
      if (splitTree !== controlledRef.current.tree) {
        console.log("[persist] tree", { id: controlledRef.current.id, internalRef: splitTree, controlledRef: controlledRef.current.tree });
        controlledRef.current.onChange({ tree: splitTree });
      }
    } else if (storageKey) {
      saveTree(storageKey, splitTree);
    }
  }, [storageKey, splitTree, controlledRef]);

  // Persist focused leaf on change.
  useEffect(() => {
    if (controlledRef.current) {
      if (focusedLeafId !== controlledRef.current.focusedLeafId) {
        console.log("[persist] focus", { id: controlledRef.current.id, internal: focusedLeafId, controlled: controlledRef.current.focusedLeafId });
        controlledRef.current.onChange({ focusedLeafId });
      }
    } else if (storageKey) {
      saveFocusedLeaf(storageKey, focusedLeafId);
    }
  }, [storageKey, focusedLeafId, controlledRef]);

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
