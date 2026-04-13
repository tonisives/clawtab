import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneContent, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves } from "@clawtab/shared";
import type { Job } from "../../../types";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";

interface UsePaneForkingParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  viewing: ReturnType<typeof useViewingState>;
}

export function usePaneForking({ core, split, lifecycle, viewing }: UsePaneForkingParams) {
  const { shellPanes, setShellPanes } = lifecycle;
  const { setScrollToSlug } = viewing;

  const addForkedProcessLeaf = useCallback((sourcePaneId: string, newPaneId: string, direction: "right" | "down") => {
    const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
    const leaves = split.tree ? collectLeaves(split.tree) : [];
    const sourceLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === sourcePaneId);
    if (sourceLeaf) {
      split.addSplitLeaf(sourceLeaf.id, { kind: "process", paneId: newPaneId }, treeDirection);
    }
  }, [split]);

  const handleFork = useCallback(async (paneId: string, direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane", { paneId, direction });
      await core.reload();
      addForkedProcessLeaf(paneId, newPaneId, direction);
    } catch (e) {
      console.error("fork_pane failed:", e);
    }
  }, [addForkedProcessLeaf, core]);

  const handleForkWithSecrets = useCallback(async (paneId: string, secretKeys: string[], direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane_with_secrets", { paneId, secretKeys, direction });
      await core.reload();
      addForkedProcessLeaf(paneId, newPaneId, direction);
    } catch (e) {
      console.error("fork_pane_with_secrets failed:", e);
    }
  }, [addForkedProcessLeaf, core]);

  const handleSplitPane = useCallback(async (paneId: string, direction: "right" | "down") => {
    try {
      const baseShell = await invoke<ShellPane>("split_pane_plain", { paneId, direction });
      const sourceProc = core.processes.find((p) => p.pane_id === paneId);
      const sourceShell = shellPanes.find((p) => p.pane_id === paneId);
      const sourceJob = (core.jobs as Job[]).find((job) => {
        const status = core.statuses[job.slug];
        return status?.state === "running" && (status as { pane_id?: string }).pane_id === paneId;
      });
      const shell: ShellPane = {
        ...baseShell,
        matched_group: sourceProc?.matched_group
          ?? sourceShell?.matched_group
          ?? sourceJob?.group
          ?? null,
      };
      setShellPanes((prev) => prev.some((p) => p.pane_id === shell.pane_id) ? prev : [...prev, shell]);
      setScrollToSlug(shell.pane_id);

      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => {
        if ((l.content.kind === "process" || l.content.kind === "terminal") && l.content.paneId === paneId) return true;
        if (l.content.kind === "job") {
          const st = core.statuses[l.content.slug];
          return st?.state === "running" && (st as { pane_id?: string }).pane_id === paneId;
        }
        return false;
      });
      const terminalContent: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, terminalContent, treeDirection);
      } else if (split.tree) {
        split.openContent(terminalContent);
      } else {
        split.addSplitLeaf("_root", terminalContent, treeDirection);
      }
      requestXtermPaneFocus(shell.pane_id);
    } catch (e) {
      console.error("split_pane_plain failed:", e);
    }
  }, [core, setScrollToSlug, setShellPanes, shellPanes, split]);

  return { handleFork, handleForkWithSecrets, handleSplitPane };
}
