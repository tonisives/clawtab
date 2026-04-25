import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DetectedProcess, ShellPane, PaneContent, RemoteJob, SplitNode } from "@clawtab/shared";
import {
  collectLeaves,
  findParentSplit,
  shortenPath,
  type SidebarSelectableItem,
  type useJobsCore,
  type useSplitTree,
} from "@clawtab/shared";
import {
  APP_SHORTCUT_EVENT,
  eventToShortcutBinding,
  normalizeShortcutBinding,
  shortcutCompletesSequence,
  shortcutMatches,
  shortcutStartsWith,
} from "../../../shortcuts";
import type { useViewingState } from "./useViewingState";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useJobsTabSettings } from "./useJobsTabSettings";
import { requestXtermPaneFocus } from "../../XtermPane";

interface Transport {
  stopJob: (slug: string) => void;
}

type PaneMoveDirection = "left" | "right" | "up" | "down";
type PaneResizeDirection = "left" | "right" | "up" | "down";
type LeafRect = { id: string; x: number; y: number; w: number; h: number };

const RESIZE_STEP = 0.05;
const RESIZE_MIN_RATIO = 0.05;
const RESIZE_MAX_RATIO = 0.95;

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
  toggleActiveAutoYes?: () => void;
  onBackNavigation?: () => void;
  onForwardNavigation?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenSettings?: () => void;
}

function collectLeafRects(
  node: SplitNode,
  x: number,
  y: number,
  w: number,
  h: number,
): LeafRect[] {
  if (node.type === "leaf") return [{ id: node.id, x, y, w, h }];
  if (node.direction === "horizontal") {
    const firstW = w * node.ratio;
    return [
      ...collectLeafRects(node.first, x, y, firstW, h),
      ...collectLeafRects(node.second, x + firstW, y, w - firstW, h),
    ];
  }
  const firstH = h * node.ratio;
  return [
    ...collectLeafRects(node.first, x, y, w, firstH),
    ...collectLeafRects(node.second, x, y + firstH, w, h - firstH),
  ];
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function findLeafInDirection(leaves: LeafRect[], focusedLeafId: string | null, direction: PaneMoveDirection): string | null {
  const current = leaves.find((leaf) => leaf.id === focusedLeafId) ?? leaves[0];
  if (!current) return null;

  const currentCenterX = current.x + current.w / 2;
  const currentCenterY = current.y + current.h / 2;
  const isHorizontal = direction === "left" || direction === "right";

  const candidates = leaves
    .filter((leaf) => leaf.id !== current.id)
    .map((leaf) => {
      const centerX = leaf.x + leaf.w / 2;
      const centerY = leaf.y + leaf.h / 2;
      const primaryDelta =
        direction === "left"
          ? current.x - (leaf.x + leaf.w)
          : direction === "right"
            ? leaf.x - (current.x + current.w)
            : direction === "up"
              ? current.y - (leaf.y + leaf.h)
              : leaf.y - (current.y + current.h);
      if (primaryDelta < -0.5) return null;

      const perpendicularOverlap = isHorizontal
        ? overlap(current.y, current.y + current.h, leaf.y, leaf.y + leaf.h)
        : overlap(current.x, current.x + current.w, leaf.x, leaf.x + leaf.w);
      if (perpendicularOverlap <= 0) return null;

      const crossDelta = Math.abs(isHorizontal ? centerY - currentCenterY : centerX - currentCenterX);
      const containsProjectedCenter = isHorizontal
        ? leaf.y <= currentCenterY && currentCenterY <= leaf.y + leaf.h
        : leaf.x <= currentCenterX && currentCenterX <= leaf.x + leaf.w;

      return { id: leaf.id, primaryDelta, perpendicularOverlap, crossDelta, containsProjectedCenter };
    })
    .filter((candidate): candidate is { id: string; primaryDelta: number; perpendicularOverlap: number; crossDelta: number; containsProjectedCenter: boolean } => !!candidate)
    .sort((a, b) => {
      if (a.containsProjectedCenter !== b.containsProjectedCenter) return a.containsProjectedCenter ? -1 : 1;
      if (a.primaryDelta !== b.primaryDelta) return a.primaryDelta - b.primaryDelta;
      if (a.perpendicularOverlap !== b.perpendicularOverlap) return b.perpendicularOverlap - a.perpendicularOverlap;
      return a.crossDelta - b.crossDelta;
    });

  return candidates[0]?.id ?? null;
}

function collectDomLeafRects(container: HTMLElement): LeafRect[] {
  const containerRect = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll<HTMLElement>("[data-leaf-id]")).map((leaf) => {
    const rect = leaf.getBoundingClientRect();
    return {
      id: leaf.dataset.leafId ?? "",
      x: rect.left - containerRect.left,
      y: rect.top - containerRect.top,
      w: rect.width,
      h: rect.height,
    };
  }).filter((leaf) => !!leaf.id && leaf.w > 0 && leaf.h > 0);
}

function getTargetLeafId(target: EventTarget | null): string | null {
  if (target instanceof HTMLElement) {
    const leafElement = target.closest<HTMLElement>("[data-leaf-id]");
    if (leafElement?.dataset.leafId) return leafElement.dataset.leafId;
  }
  return null;
}

function getActiveLeafId(container: HTMLElement, fallbackLeafId: string | null): string | null {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && container.contains(activeElement)) {
    const leafElement = activeElement.closest<HTMLElement>("[data-leaf-id]");
    if (leafElement?.dataset.leafId) return leafElement.dataset.leafId;
  }
  return fallbackLeafId;
}

function paneContentMatchesPaneId(content: PaneContent, paneId: string): boolean {
  return (content.kind === "process" || content.kind === "terminal") && content.paneId === paneId;
}

export function useKeyboardShortcuts({
  core, split, viewing, lifecycle, settings,
  transport,
  activePaneContent, activeProcessForRename,
  setEditProcessField, openRenameProcessDialog,
  handleSplitPane, getPaneIdForContent,
  handleSelectJob, handleSelectProcess, handleSelectShell,
  sidebarSelectableItems, sidebarFocusRef,
  toggleActiveAutoYes,
  onBackNavigation,
  onForwardNavigation,
  onOpenCommandPalette,
  onOpenSettings,
}: UseKeyboardShortcutsParams) {
  const { shortcutSettings } = settings;
  const {
    viewingJob, viewingProcess, viewingShell,
    setViewingJob, setViewingProcess, setViewingShell, setViewingAgent,
    currentContent, setScrollToSlug, triggerFocusAgentInput,
  } = viewing;

  const triggerRevealInSidebar = useCallback((sourcePaneId?: string | null) => {
    // Prefer an explicit sourcePaneId (from an xterm-dispatched shortcut or a
    // [data-leaf-id]-targeted keydown), then fall back to the currently focused
    // leaf, then to currentContent (the sidebar's selection).
    let id: string | null = null;
    if (sourcePaneId) {
      id = sourcePaneId;
    } else if (split.tree && split.focusedLeafId) {
      const leaf = collectLeaves(split.tree).find((l) => l.id === split.focusedLeafId);
      const content = leaf?.content;
      if (content?.kind === "job") id = content.slug;
      else if (content?.kind === "process" || content?.kind === "terminal") id = content.paneId;
    }
    if (!id && currentContent) {
      if (currentContent.kind === "job") id = currentContent.slug;
      else if (currentContent.kind === "process" || currentContent.kind === "terminal") id = currentContent.paneId;
    }
    if (!id) return;
    setScrollToSlug(id);
    sidebarFocusRef.current?.focus();
  }, [currentContent, setScrollToSlug, sidebarFocusRef, split.tree, split.focusedLeafId]);
  const {
    pendingProcess,
    setStoppingProcesses, setStoppingJobSlugs,
    setShellPanes, demotedShellPaneIdsRef,
  } = lifecycle;

  const [pendingShortcutStroke, setPendingShortcutStroke] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const openRenameDialogForPaneId = useCallback((paneId: string): boolean => {
    const process = core.processes.find((entry) => entry.pane_id === paneId)
      ?? (pendingProcess?.pane_id === paneId ? pendingProcess : null);
    if (process && !process._transient_state) {
      openRenameProcessDialog(process);
      return true;
    }

    const shell = lifecycle.shellPanes.find((entry) => entry.pane_id === paneId);
    if (shell) {
      setEditProcessField({
        paneId: shell.pane_id,
        title: "Edit pane title",
        label: "Title",
        field: "display_name",
        initialValue: shell.display_name ?? shell.pane_title ?? "",
        placeholder: shortenPath(shell.cwd),
      });
      return true;
    }
    return false;
  }, [core.processes, lifecycle.shellPanes, openRenameProcessDialog, pendingProcess, setEditProcessField]);

  const triggerRenameActivePane = useCallback((sourcePaneId?: string | null) => {
    if (sourcePaneId && openRenameDialogForPaneId(sourcePaneId)) return;

    if (activePaneContent?.kind === "terminal" || activePaneContent?.kind === "process") {
      if (openRenameDialogForPaneId(activePaneContent.paneId)) return;
    }
    if (!activeProcessForRename || activeProcessForRename._transient_state) return;
    openRenameProcessDialog(activeProcessForRename);
  }, [activePaneContent, activeProcessForRename, openRenameDialogForPaneId, openRenameProcessDialog]);

  const triggerEnterCopyMode = useCallback((sourcePaneId?: string | null) => {
    let paneId: string | null = sourcePaneId ?? null;
    if (!paneId && split.tree) {
      const leaves = collectLeaves(split.tree);
      const focused = leaves.find((leaf) => leaf.id === split.focusedLeafId) ?? leaves[0];
      if (focused) paneId = getPaneIdForContent(focused.content);
    }
    if (!paneId) paneId = getPaneIdForContent(activePaneContent);
    if (!paneId) return;
    invoke("enter_copy_mode", { paneId });
  }, [split.tree, split.focusedLeafId, getPaneIdForContent, activePaneContent]);

  const triggerZoomActivePane = useCallback(() => {
    const leaves = split.tree ? collectLeaves(split.tree) : [];
    const focusedLeaf = leaves.find((leaf) => leaf.id === split.focusedLeafId) ?? leaves[0];
    const targetContent = focusedLeaf?.content ?? activePaneContent;
    const paneId = getPaneIdForContent(targetContent);
    if (focusedLeaf) {
      split.toggleZoomLeaf(focusedLeaf.id);
    } else {
      split.toggleZoomLeaf("");
    }
    if (paneId) requestAnimationFrame(() => requestXtermPaneFocus(paneId));
  }, [split.tree, split.focusedLeafId, split.toggleZoomLeaf, activePaneContent, getPaneIdForContent]);

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

    const runMovePaneShortcut = (direction: PaneMoveDirection, options?: { sourcePaneId?: string; sourceLeafId?: string | null }) => {
      const tree = split.tree;
      if (!tree) return;
      const container = split.detailPaneRef.current;
      const width = container?.clientWidth ?? split.detailSize.w;
      const height = container?.clientHeight ?? split.detailSize.h;
      if (width <= 0 || height <= 0) return;

      const sourceLeafId = options?.sourceLeafId ?? (options?.sourcePaneId
        ? collectLeaves(tree).find((leaf) => paneContentMatchesPaneId(leaf.content, options.sourcePaneId!))?.id
        : null);
      const currentLeafId = sourceLeafId ?? (container ? getActiveLeafId(container, split.focusedLeafId) : split.focusedLeafId);
      const nextLeafId = findLeafInDirection(
        container ? collectDomLeafRects(container) : collectLeafRects(tree, 0, 0, width, height),
        currentLeafId,
        direction,
      );
      if (nextLeafId) split.setFocusedLeafId(nextLeafId);
    };

    const runResizePaneShortcut = (direction: PaneResizeDirection, options?: { sourcePaneId?: string; sourceLeafId?: string | null }) => {
      const tree = split.tree;
      if (!tree) return;
      const sourceLeafId = options?.sourceLeafId ?? (options?.sourcePaneId
        ? collectLeaves(tree).find((leaf) => paneContentMatchesPaneId(leaf.content, options.sourcePaneId!))?.id
        : null);
      const leafId = sourceLeafId ?? split.focusedLeafId ?? collectLeaves(tree)[0]?.id ?? null;
      if (!leafId) return;
      const splitDirection = direction === "left" || direction === "right" ? "horizontal" : "vertical";
      const parent = findParentSplit(tree, leafId, splitDirection);
      if (!parent) return;
      const leafIsFirst = collectLeaves(parent.first).some((l) => l.id === leafId);
      const grow = direction === "right" || direction === "down";
      const delta = leafIsFirst === grow ? RESIZE_STEP : -RESIZE_STEP;
      const next = Math.min(RESIZE_MAX_RATIO, Math.max(RESIZE_MIN_RATIO, parent.ratio + delta));
      if (next === parent.ratio) return;
      split.handleSplitRatioChange(parent.id, next);
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
      { binding: shortcutSettings.reveal_in_sidebar, run: triggerRevealInSidebar },
      { binding: shortcutSettings.enter_copy_mode, run: () => triggerEnterCopyMode() },
      { binding: shortcutSettings.next_sidebar_item, run: () => navigateSidebarItems(1) },
      { binding: shortcutSettings.previous_sidebar_item, run: () => navigateSidebarItems(-1) },
      ...(toggleActiveAutoYes ? [{ binding: shortcutSettings.toggle_auto_yes, run: toggleActiveAutoYes }] : []),
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
      { binding: shortcutSettings.move_pane_left, run: () => runMovePaneShortcut("left") },
      { binding: shortcutSettings.move_pane_up, run: () => runMovePaneShortcut("up") },
      { binding: shortcutSettings.move_pane_down, run: () => runMovePaneShortcut("down") },
      { binding: shortcutSettings.move_pane_right, run: () => runMovePaneShortcut("right") },
      { binding: shortcutSettings.resize_pane_left, run: () => runResizePaneShortcut("left") },
      { binding: shortcutSettings.resize_pane_right, run: () => runResizePaneShortcut("right") },
      { binding: shortcutSettings.resize_pane_up, run: () => runResizePaneShortcut("up") },
      { binding: shortcutSettings.resize_pane_down, run: () => runResizePaneShortcut("down") },
      ...(onBackNavigation ? [{ binding: shortcutSettings.back_navigation, run: onBackNavigation }] : []),
      ...(onForwardNavigation ? [{ binding: shortcutSettings.forward_navigation, run: onForwardNavigation }] : []),
      ...(onOpenCommandPalette ? [{ binding: shortcutSettings.open_command_palette, run: onOpenCommandPalette }] : []),
      ...(onOpenSettings ? [{ binding: shortcutSettings.open_settings, run: onOpenSettings }] : []),
    ];

    const runAppShortcutBinding = (binding: string, sourcePaneId?: string) => {
      const normalizedBinding = normalizeShortcutBinding(binding, shortcutSettings.prefix_key);
      const renameBinding = normalizeShortcutBinding(shortcutSettings.rename_active_pane, shortcutSettings.prefix_key);
      if (normalizedBinding === renameBinding) {
        setPendingShortcutStroke(null);
        triggerRenameActivePane(sourcePaneId);
        return true;
      }
      const revealBinding = normalizeShortcutBinding(shortcutSettings.reveal_in_sidebar, shortcutSettings.prefix_key);
      if (normalizedBinding === revealBinding) {
        setPendingShortcutStroke(null);
        triggerRevealInSidebar(sourcePaneId);
        return true;
      }
      const copyModeBinding = normalizeShortcutBinding(shortcutSettings.enter_copy_mode, shortcutSettings.prefix_key);
      if (normalizedBinding === copyModeBinding) {
        setPendingShortcutStroke(null);
        triggerEnterCopyMode(sourcePaneId);
        return true;
      }
      const movementBindings: Array<{ binding: string; direction: PaneMoveDirection }> = [
        { binding: shortcutSettings.move_pane_left, direction: "left" },
        { binding: shortcutSettings.move_pane_up, direction: "up" },
        { binding: shortcutSettings.move_pane_down, direction: "down" },
        { binding: shortcutSettings.move_pane_right, direction: "right" },
      ];
      const movement = movementBindings.find((candidate) => normalizeShortcutBinding(candidate.binding, shortcutSettings.prefix_key) === normalizedBinding);
      if (movement) {
        setPendingShortcutStroke(null);
        runMovePaneShortcut(movement.direction, { sourcePaneId });
        return true;
      }
      const resizeBindings: Array<{ binding: string; direction: PaneResizeDirection }> = [
        { binding: shortcutSettings.resize_pane_left, direction: "left" },
        { binding: shortcutSettings.resize_pane_right, direction: "right" },
        { binding: shortcutSettings.resize_pane_up, direction: "up" },
        { binding: shortcutSettings.resize_pane_down, direction: "down" },
      ];
      const resize = resizeBindings.find((candidate) => normalizeShortcutBinding(candidate.binding, shortcutSettings.prefix_key) === normalizedBinding);
      if (resize) {
        setPendingShortcutStroke(null);
        runResizePaneShortcut(resize.direction, { sourcePaneId });
        return true;
      }
      const splitBindings: Array<{ binding: string; direction: "right" | "down" }> = [
        { binding: shortcutSettings.split_pane_vertical, direction: "right" },
        { binding: shortcutSettings.split_pane_horizontal, direction: "down" },
      ];
      const splitAction = splitBindings.find((candidate) => normalizeShortcutBinding(candidate.binding, shortcutSettings.prefix_key) === normalizedBinding);
      if (splitAction && sourcePaneId) {
        setPendingShortcutStroke(null);
        handleSplitPane(sourcePaneId, splitAction.direction);
        return true;
      }
      const action = actions.find((candidate) => normalizeShortcutBinding(candidate.binding, shortcutSettings.prefix_key) === normalizedBinding);
      if (!action) return false;
      setPendingShortcutStroke(null);
      action.run();
      return true;
    };

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
          (e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled = true;
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
        (e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled = true;
        e.preventDefault();
        setPendingShortcutStroke(stroke);
        return;
      }

      const singleStrokeMatch = actions.find(({ binding }) => shortcutMatches(e, binding, shortcutSettings.prefix_key));
      if (singleStrokeMatch) {
        const movementBindings: Array<{ binding: string; direction: PaneMoveDirection }> = [
          { binding: shortcutSettings.move_pane_left, direction: "left" },
          { binding: shortcutSettings.move_pane_up, direction: "up" },
          { binding: shortcutSettings.move_pane_down, direction: "down" },
          { binding: shortcutSettings.move_pane_right, direction: "right" },
        ];
        const movement = movementBindings.find((candidate) => normalizeShortcutBinding(candidate.binding, shortcutSettings.prefix_key) === normalizeShortcutBinding(singleStrokeMatch.binding, shortcutSettings.prefix_key));
        (e as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled = true;
        e.preventDefault();
        if (movement) {
          runMovePaneShortcut(movement.direction, { sourceLeafId: getTargetLeafId(e.target) });
          return;
        }
        if (normalizeShortcutBinding(singleStrokeMatch.binding, shortcutSettings.prefix_key) === normalizeShortcutBinding(shortcutSettings.rename_active_pane, shortcutSettings.prefix_key)) {
          const targetLeafId = getTargetLeafId(e.target);
          const targetContent = targetLeafId && split.tree
            ? collectLeaves(split.tree).find((leaf) => leaf.id === targetLeafId)?.content ?? null
            : null;
          triggerRenameActivePane(getPaneIdForContent(targetContent));
          return;
        }
        if (normalizeShortcutBinding(singleStrokeMatch.binding, shortcutSettings.prefix_key) === normalizeShortcutBinding(shortcutSettings.reveal_in_sidebar, shortcutSettings.prefix_key)) {
          const targetLeafId = getTargetLeafId(e.target);
          const targetContent = targetLeafId && split.tree
            ? collectLeaves(split.tree).find((leaf) => leaf.id === targetLeafId)?.content ?? null
            : null;
          triggerRevealInSidebar(getPaneIdForContent(targetContent));
          return;
        }
        singleStrokeMatch.run();
        return;
      }
    };

    const handleAppShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; binding?: string; paneId?: string }>).detail;
      if (detail?.action === "rename_active_pane") {
        triggerRenameActivePane(detail.paneId);
        return;
      }
      if (detail?.binding) runAppShortcutBinding(detail.binding, detail.paneId);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener(APP_SHORTCUT_EVENT, handleAppShortcut);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener(APP_SHORTCUT_EVENT, handleAppShortcut);
    };
  }, [pendingShortcutStroke, split.tree, split.focusedLeafId, split.setFocusedLeafId, split.handleClosePane, split.handleSplitRatioChange, split.detailPaneRef, split.detailSize.w, split.detailSize.h, currentContent, core.processes, core.requestFastPoll, getPaneIdForContent, handleSplitPane, navigateSidebarItems, pendingProcess, shortcutSettings, triggerRenameActivePane, triggerFocusAgentInput, triggerZoomActivePane, triggerRevealInSidebar, triggerEnterCopyMode, setStoppingProcesses, setStoppingJobSlugs, setShellPanes, demotedShellPaneIdsRef, setViewingJob, setViewingProcess, setViewingShell, setViewingAgent, transport, sidebarFocusRef, toggleActiveAutoYes, onBackNavigation, onForwardNavigation, onOpenCommandPalette, onOpenSettings]);

  useEffect(() => {
    const unlistenPromise = listen<string>("shortcut-action", (event) => {
      if (event.payload === "rename_active_pane") triggerRenameActivePane();
      if (event.payload === "focus_agent_input") triggerFocusAgentInput();
      if (event.payload === "zoom_active_pane") triggerZoomActivePane();
      if (event.payload === "toggle_auto_yes") toggleActiveAutoYes?.();
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [triggerFocusAgentInput, triggerRenameActivePane, triggerZoomActivePane, toggleActiveAutoYes]);

  return {
    pendingShortcutStroke,
    sidebarCollapsed, setSidebarCollapsed,
    triggerRenameActivePane,
    triggerZoomActivePane,
    triggerRevealInSidebar,
    navigateSidebarItems,
  };
}
