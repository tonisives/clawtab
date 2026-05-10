import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneContent, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves } from "@clawtab/shared";
import type { Job } from "../../../types";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

interface UsePaneForkingParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  viewing: ReturnType<typeof useViewingState>;
}

type Direction = "right" | "down";
type TreeDirection = "horizontal" | "vertical";

function toTreeDirection(d: Direction): TreeDirection {
  return d === "right" ? "horizontal" : "vertical";
}

export function usePaneForking({ core, split, lifecycle, viewing }: UsePaneForkingParams) {
  const { shellPanes, setShellPanes } = lifecycle;
  const { setScrollToSlug } = viewing;
  const mgr = useWorkspaceManager();

  const findSourceLeafId = useCallback((sourcePaneId: string, matchedJobSlug: string | null): string | null => {
    const leaves = split.tree ? collectLeaves(split.tree) : [];
    const hit = leaves.find((l) => {
      if ((l.content.kind === "process" || l.content.kind === "terminal") && l.content.paneId === sourcePaneId) return true;
      if (l.content.kind === "job") {
        const st = core.statuses[l.content.slug];
        const statusPaneId = st?.state === "running" ? (st as { pane_id?: string }).pane_id : undefined;
        return statusPaneId === sourcePaneId || matchedJobSlug === l.content.slug;
      }
      return false;
    });
    return hit?.id ?? null;
  }, [split.tree, core.statuses]);

  const graftLeaf = useCallback((sourceLeafId: string | null, content: PaneContent, treeDirection: TreeDirection) => {
    if (sourceLeafId) {
      split.addSplitLeaf(sourceLeafId, content, treeDirection);
    } else if (split.tree) {
      split.openContent(content);
    } else {
      split.addSplitLeaf("_root", content, treeDirection);
    }
  }, [split]);

  const forkImpl = useCallback(async (
    paneId: string,
    direction: Direction,
    secretKeys: string[] | undefined,
  ) => {
    try {
      const args: Record<string, unknown> = { paneId, direction };
      if (secretKeys && secretKeys.length > 0) args.secretKeys = secretKeys;
      const newPaneId = await invoke<string>("fork_pane", args);
      await core.reload();
      const sourceProc = core.processes.find((p) => p.pane_id === paneId);
      const sourceLeafId = findSourceLeafId(paneId, sourceProc?.matched_job ?? null);
      graftLeaf(sourceLeafId, { kind: "process", paneId: newPaneId }, toTreeDirection(direction));
      requestXtermPaneFocus(newPaneId);
    } catch (e) {
      console.error("fork_pane failed:", e);
    }
  }, [core, findSourceLeafId, graftLeaf]);

  const handleFork = useCallback(
    (paneId: string, direction: Direction = "down") => forkImpl(paneId, direction, undefined),
    [forkImpl],
  );

  const handleForkWithSecrets = useCallback(
    (paneId: string, secretKeys: string[], direction: Direction = "down") => forkImpl(paneId, direction, secretKeys),
    [forkImpl],
  );

  const attachShellPane = useCallback((baseShell: ShellPane, sourcePaneId: string, direction: Direction) => {
    const sourceProc = core.processes.find((p) => p.pane_id === sourcePaneId);
    const sourceShell = shellPanes.find((p) => p.pane_id === sourcePaneId);
    const sourceJob = (core.jobs as Job[]).find((job) => {
      const status = core.statuses[job.slug];
      const statusPaneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return statusPaneId === sourcePaneId || sourceProc?.matched_job === job.slug;
    });
    const shell: ShellPane = {
      ...baseShell,
      matched_group: sourceProc?.matched_group
        ?? sourceShell?.matched_group
        ?? sourceJob?.group
        ?? null,
      workspace_id: sourceShell?.workspace_id ?? mgr.activeId,
    };
    setShellPanes((prev) => prev.some((p) => p.pane_id === shell.pane_id) ? prev : [...prev, shell]);
    setScrollToSlug(shell.pane_id);

    const sourceLeafId = findSourceLeafId(sourcePaneId, sourceProc?.matched_job ?? null);
    graftLeaf(
      sourceLeafId,
      { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session },
      toTreeDirection(direction),
    );
    requestXtermPaneFocus(shell.pane_id);
  }, [core, findSourceLeafId, graftLeaf, mgr, setScrollToSlug, setShellPanes, shellPanes]);

  const handleSplitPane = useCallback(async (paneId: string, direction: Direction) => {
    try {
      const baseShell = await invoke<ShellPane>("split_pane_plain", { paneId, direction });
      attachShellPane(baseShell, paneId, direction);
    } catch (e) {
      console.error("split_pane_plain failed:", e);
    }
  }, [attachShellPane]);

  const handleResumeSession = useCallback(async (sessionId: string, cwd: string, sourcePaneId: string | null) => {
    if (!sourcePaneId) {
      console.warn("handleResumeSession: no source pane to split from");
      return;
    }
    const command = `claude --resume ${sessionId}`;
    try {
      const baseShell = await invoke<ShellPane>("split_pane_with_command", {
        paneId: sourcePaneId,
        direction: "right",
        command,
        cwd: cwd || null,
      });
      attachShellPane(baseShell, sourcePaneId, "right");
    } catch (e) {
      console.error("split_pane_with_command failed:", e);
    }
  }, [attachShellPane]);

  return { handleFork, handleForkWithSecrets, handleSplitPane, handleResumeSession };
}
