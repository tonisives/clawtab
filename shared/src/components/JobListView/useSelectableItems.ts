import { useEffect, useMemo, useRef } from "react";

import type { DetectedProcess } from "../../types/process";
import type { ListItem, SidebarSelectableItem } from "./sign";
import { areSelectableItemsEqual } from "./helpers";

interface UseSelectableItemsParams {
  items: ListItem[];
  matchedProcessesByJob: Map<string, DetectedProcess[]>;
  onSelectableItemsChange?: (items: SidebarSelectableItem[]) => void;
}

export function useSelectableItems({
  items,
  matchedProcessesByJob,
  onSelectableItemsChange,
}: UseSelectableItemsParams) {
  const selectableItems = useMemo((): SidebarSelectableItem[] => (
    items.flatMap((item): SidebarSelectableItem[] => {
      if (item.kind === "job") {
        return [
          { kind: "job", key: item.job.slug, job: item.job },
          ...(matchedProcessesByJob.get(item.job.slug) ?? []).map((process) => (
            { kind: "process" as const, key: process.pane_id, process }
          )),
        ];
      }
      if (item.kind === "process") return [{ kind: "process", key: item.process.pane_id, process: item.process }];
      if (item.kind === "shell") return [{ kind: "shell", key: `_term_${item.shell.pane_id}`, shell: item.shell }];
      return [];
    })
  ), [items, matchedProcessesByJob]);

  const lastSelectableItemsRef = useRef<SidebarSelectableItem[]>([]);
  useEffect(() => {
    if (areSelectableItemsEqual(lastSelectableItemsRef.current, selectableItems)) {
      return;
    }
    lastSelectableItemsRef.current = selectableItems;
    onSelectableItemsChange?.(selectableItems);
  }, [onSelectableItemsChange, selectableItems]);

  return selectableItems;
}
