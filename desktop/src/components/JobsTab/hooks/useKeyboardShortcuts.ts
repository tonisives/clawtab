import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DetectedProcess, ShellPane, PaneContent, RemoteJob } from "@clawtab/shared";
import {
  collectLeaves,
  shortenPath,
  type SidebarSelectableItem,
  type useJobsCore,
  type useSplitTree,
} from "@clawtab/shared";
import {
  eventToShortcutBinding,
  shortcutCompletesSequence,
  shortcutMatches,
  shortcutStartsWith,
} from "../../../shortcuts";
import type { useViewingState } from "./useViewingState";
import type { useProcessLifecycle } from "./useProcessLifecycle";
import type { useJobsTabSettings } from "./useJobsTabSettings";

interface Transport {
  stopJob: (slug: string) => void;
}

interface EditProcessField {
  paneId: string;
  title: string;
  label: string;
  field: "display_name";
  initialValue: string;
  placeholder?: string;
}

interface UseKeyboardShortcutsParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  settings: ReturnType<typeof useJobsTabSettings>;
  transport: Transport;
  activePaneContent: PaneContent | null;
  activeProcessForRename: DetectedProcess | null;
  setEditProcessField: (value: EditProcessField | null) => void;
  openRenameProcessDialog: (process: DetectedProcess) => void;
  handleSplitPane: (paneId: string, direction: "right" | "down") => void;
  getPaneIdForContent: (content: PaneContent | null) => string | null;
  handleSelectJob: (job: RemoteJob) => void;
  handleSelectProcess: (process: DetectedProcess) => void;
  handleSelectShell: (shell: ShellPane) => void;
  sidebarSelectableItems: SidebarSelectableItem[];
  sidebarFocusRef: React.RefObject<{ focus: () => void } | null>;
}

export function useKeyboardShortcuts({
  core, split, viewing, lifecycle, settings,
  transport,
  activePaneContent, activeProcessForRename,
  setEditProcessField, openRenameProcessDialog,
  handleSplitPane, getPaneIdForContent,
  handleSelectJob, handleSelectProcess, handleSelectShell,
  sidebarSelectableItems, sidebarFocusRef,
}: UseKeyboardShortcutsParams) {
  const { shortcutSettings } = settings;
  const {
    viewingJob, viewingProcess, viewingShell,
    setViewingJob, setViewingProcess, setViewingShell, setViewingAgent,
    currentContent, setScrollToSlug, triggerFocusAgentInput,
  } = viewing;
  const {
    pendingProcess,
    setStoppingProcesses, setStoppingJobSlugs,
    setShellPanes, demotedShellPaneIdsRef,
  } = lifecycle;

  const [pendingShortcutStroke, setPendingShortcutStroke] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const triggerRenameActivePane = useCallback(() => {
    if (activePaneContent?.kind === "terminal") {
      const shell = lifecycle.shellPanes.find((entry) => entry.pane_id === activePaneContent.paneId);
      if (!shell) return;
      setEditProcessField({
        paneId: shell.pane_id,
        title: "Edit pane title",
        label: "Title",
        field: "display_name",
        initialValue: shell.display_name ?? "",
        placeholder: shortenPath(shell.cwd),
      });
      return;
    }
    if (!activeProcessForRename || activeProcessForRename._transient_state) return;
    openRenameProcessDialog(activeProcessForRename);
  }, [activePaneContent, activeProcessForRename, setEditProcessField, openRenameProcessDialog, lifecycle.shellPanes]);

  const triggerZoomActivePane = useCallback(() => {
    const leaves = split.tree ? collectLeaves(split.tree) : [];
    const focusedLeaf = leaves.find((leaf) => leaf.id === split.focusedLeafId) ?? leaves[0];
    if (focusedLeaf) {
      split.toggleZoomLeaf(focusedLeaf.id);
      return;
    }
    split.toggleZoomLeaf("");
  }, [split.tree, split.focusedLeafId, split.toggleZoomLeaf]);

  const navigateSidebarItems = useCallback((direction: 1 | -1) => {
    if (sidebarSelectableItems.length === 0) return;
    sidebarFocusRef.current?.focus();

    const currentKey = split.focusedItemKey
      ?? (viewingShell
        ? `_term_${viewingShell.pane_id}`
        : viewingProcess
          ? viewingProcess.pane_id
          : viewingJob?.slug ?? null);
    const currentIndex = currentKey
      ? sidebarSelectableItems.findIndex((item) => item.key === currentKey)
      : -1;
    const baseIndex = currentIndex === -1
      ? (direction > 0 ? -1 : 0)
      : currentIndex;
    const nextIndex = (baseIndex + direction + sidebarSelectableItems.length) % sidebarSelectableItems.length;
    const nextItem = sidebarSelectableItems[nextIndex];
    if (!nextItem) return;

    if (nextItem.kind === "job") {
      handleSelectJob(nextItem.job);
      setScrollToSlug(nextItem.job.slug);
      return;
    }
    if (nextItem.kind === "process") {
      handleSelectProcess(nextItem.process);
      setScrollToSlug(nextItem.process.pane_id);
      return;
    }
    handleSelectShell(nextItem.shell);
    setScrollToSlug(nextItem.shell.pane_id);
  }, [sidebarSelectableItems, split.focusedItemKey, viewingShell, viewingProcess, viewingJob, handleSelectJob, handleSelectProcess, handleSelectShell, setScrollToSlug, sidebarFocusRef]);

  // Keyboard shortcuts
  useEffect(() => {
    const runSplitPaneShortcut = (direction: "right" | "down") => {
      const tree = split.tree;
      if (!tree) {
        const paneId = getPaneIdForContent(currentContent);
        if (paneId) handleSplitPane(paneId, direction);
        return;
      }
      const leaves = collectLeaves(tree);
      const focused = leaves.find(l => l.id === split.focusedLeafId) ?? leaves[0];
      if (!focused) return;
      const paneId = getPaneIdForContent(focused.content);
      if (paneId) handleSplitPane(paneId, direction);
    };

    const runMovePaneShortcut = (direction: "backward" | "forward") => {
      const tree = split.tree;
      if (!tree) return;
      const leaves = collectLeaves(tree);
      if (leaves.length < 2) return;
      const currentIdx = leaves.findIndex(l => l.id === split.focusedLeafId);
      const idx = currentIdx === -1 ? 0 : currentIdx;
      const next = direction === "backward"
        ? (idx - 1 + leaves.length) % leaves.length
        : (idx + 1) % leaves.length;
      split.setFocusedLeafId(leaves[next].id);
    };

    const runKillPaneShortcut = () => {
      const focusedLeaf = split.tree
        ? collectLeaves(split.tree).find((leaf) => leaf.id === split.focusedLeafId) ?? collectLeaves(split.tree)[0]
        : null;
      const content = focusedLeaf?.content ?? currentContent;
      if (!content) return;

      if (content.kind === "process") {
        const proc = core.processes.find((p) => p.pane_id === content.paneId) ?? pendingProcess;
        if (proc && proc.pane_id === content.paneId) {
          setStoppingProcesses((prev) => {
            if (prev.some((sp) => sp.process.pane_id === content.paneId)) return prev;
            return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
          });
        }
        core.requestFastPoll(`pane:${content.paneId}`);
        invoke("stop_detected_process", { paneId: content.paneId });
      } else if (content.kind === "terminal") {
        demotedShellPaneIdsRef.current.delete(content.paneId);
        setShellPanes((prev) => prev.filter((pane) => pane.pane_id !== content.paneId));
        invoke("stop_detected_process", { paneId: content.paneId });
      } else if (content.kind === "job") {
        setStoppingJobSlugs((prev) => new Set(prev).add(content.slug));
        core.requestFastPoll(`job:${content.slug}`);
        transport.stopJob(content.slug);
      }

      if (focusedLeaf) {
        split.handleClosePane(focusedLeaf.id);
        return;
      }

      if (content.kind === "job") setViewingJob(null);
      if (content.kind === "process") setViewingProcess(null);
      if (content.kind === "terminal") setViewingShell(null);
      if (content.kind === "agent") setViewingAgent(false);
    };

    const actions: { binding: string; run: () => void }[] = [
      { binding: shortcutSettings.rename_active_pane, run: triggerRenameActivePane },
      { binding: shortcutSettings.focus_agent_input, run: triggerFocusAgentInput },
      { binding: shortcutSettings.zoom_active_pane, run: triggerZoomActivePane },
      { binding: shortcutSettings.next_sidebar_item, run: () => navigateSidebarItems(1) },
      { binding: shortcutSettings.previous_sidebar_item, run: () => navigateSidebarItems(-1) },
      {
        binding: shortcutSettings.toggle_sidebar,
        run: () => {
          setSidebarCollapsed(prev => {
            const next = !prev;
            if (!next) requestAnimationFrame(() => sidebarFocusRef.current?.focus());
            return next;
          });
        },
      },
      { binding: shortcutSettings.split_pane_vertical, run: () => runSplitPaneShortcut("right") },
      { binding: shortcutSettings.split_pane_horizontal, run: () => runSplitPaneShortcut("down") },
      { binding: shortcutSettings.kill_pane, run: runKillPaneShortcut },
      { binding: shortcutSettings.move_pane_left, run: () => runMovePaneShortcut("backward") },
      { binding: shortcutSettings.move_pane_up, run: () => runMovePaneShortcut("backward") },
      { binding: shortcutSettings.move_pane_down, run: () => runMovePaneShortcut("forward") },
      { binding: shortcutSettings.move_pane_right, run: () => runMovePaneShortcut("forward") },
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      const inXterm = !!target?.closest(".xterm");
      const isEditable = !!target && (
        target.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      );
      if (isEditable && !inXterm && shortcutMatches(e, shortcutSettings.focus_agent_input, shortcutSettings.prefix_key)) {
        e.preventDefault();
        e.stopPropagation();
        setPendingShortcutStroke(null);
        triggerFocusAgentInput();
        return;
      }
      if (isEditable && !inXterm) return;

      if (pendingShortcutStroke && e.key === "Escape") {
        e.preventDefault();
        setPendingShortcutStroke(null);
        return;
      }

      const stroke = eventToShortcutBinding(e);
      if (pendingShortcutStroke) {
        if (!stroke) {
          e.preventDefault();
          return;
        }

        e.preventDefault();
        const sequenceMatch = actions.find(({ binding }) => shortcutCompletesSequence(binding, [pendingShortcutStroke, stroke], shortcutSettings.prefix_key));
        if (sequenceMatch) {
          setPendingShortcutStroke(null);
          sequenceMatch.run();
          return;
        }

        const nextSequence = actions.find(({ binding }) => shortcutStartsWith(binding, stroke, shortcutSettings.prefix_key));
        setPendingShortcutStroke(nextSequence ? stroke : null);
        return;
      }

      if (!stroke) return;

      const sequenceStart = actions.find(({ binding }) => shortcutStartsWith(binding, stroke, shortcutSettings.prefix_key));
      if (sequenceStart) {
        e.preventDefault();
        setPendingShortcutStroke(stroke);
        return;
      }

      const singleStrokeMatch = actions.find(({ binding }) => shortcutMatches(e, binding, shortcutSettings.prefix_key));
      if (singleStrokeMatch) {
        e.preventDefault();
        singleStrokeMatch.run();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [pendingShortcutStroke, split.tree, split.focusedLeafId, split.setFocusedLeafId, split.handleClosePane, currentContent, core.processes, core.requestFastPoll, getPaneIdForContent, handleSplitPane, navigateSidebarItems, pendingProcess, shortcutSettings, triggerRenameActivePane, triggerFocusAgentInput, triggerZoomActivePane, setStoppingProcesses, setStoppingJobSlugs, setShellPanes, demotedShellPaneIdsRef, setViewingJob, setViewingProcess, setViewingShell, setViewingAgent, transport, sidebarFocusRef]);

  useEffect(() => {
    const unlistenPromise = listen<string>("shortcut-action", (event) => {
      if (event.payload === "rename_active_pane") triggerRenameActivePane();
      if (event.payload === "focus_agent_input") triggerFocusAgentInput();
      if (event.payload === "zoom_active_pane") triggerZoomActivePane();
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [triggerFocusAgentInput, triggerRenameActivePane, triggerZoomActivePane]);

  return {
    pendingShortcutStroke,
    sidebarCollapsed, setSidebarCollapsed,
    triggerRenameActivePane,
    triggerZoomActivePane,
    navigateSidebarItems,
  };
}
