import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DetectedProcess, ShellPane, PaneContent } from "@clawtab/shared";
import { collectLeaves, type useJobsCore, type useSplitTree } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../components/XtermPane";
import type { ExistingPaneInfo } from "../types";
import type { useViewingState } from "../components/JobsTab/hooks/useViewingState";
import type { Job } from "../types";
import { useQuestionPolling } from "./useQuestionPolling";
import { useAutoYes } from "./useAutoYes";

const SHELL_PANES_STORAGE_KEY = "desktop_shell_panes";

interface UseProcessLifecycleParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
}

function isShellPane(value: ShellPane | null): value is ShellPane {
  return value !== null;
}

function isStoredShellPane(value: unknown): value is ShellPane {
  if (!value || typeof value !== "object") return false;
  const pane = value as Partial<Record<keyof ShellPane, unknown>>;
  return typeof pane.pane_id === "string"
    && typeof pane.cwd === "string"
    && typeof pane.tmux_session === "string"
    && typeof pane.window_name === "string";
}

function loadStoredShellPanes(): ShellPane[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(SHELL_PANES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredShellPane);
  } catch {
    return [];
  }
}

function saveStoredShellPanes(shellPanes: ShellPane[]) {
  if (typeof localStorage === "undefined") return;
  if (shellPanes.length === 0) {
    localStorage.removeItem(SHELL_PANES_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SHELL_PANES_STORAGE_KEY, JSON.stringify(shellPanes));
}

function terminalLeafContents(
  tree: ReturnType<typeof useSplitTree>["tree"],
): Extract<PaneContent, { kind: "terminal" }>[] {
  if (!tree) return [];
  return collectLeaves(tree)
    .map((leaf) => leaf.content)
    .filter((content): content is Extract<PaneContent, { kind: "terminal" }> => content.kind === "terminal");
}

export function useProcessLifecycle({ core, split, viewing }: UseProcessLifecycleParams) {
  const {
    viewingProcess, setViewingProcess,
    viewingShell, setViewingShell,
    setViewingJob, setViewingAgent,
    currentContent, setScrollToSlug,
  } = viewing;

  // State
  const [pendingAgentWorkDir, setPendingAgentWorkDir] = useState<{ dir: string; startedAt: number } | null>(null);
  const [pendingProcess, setPendingProcess] = useState<DetectedProcess | null>(null);
  const [stoppingProcesses, setStoppingProcesses] = useState<{ process: DetectedProcess; stoppedAt: number }[]>([]);
  const [stoppingJobSlugs, setStoppingJobSlugs] = useState<Set<string>>(new Set());
  const [shellPanes, setShellPanes] = useState<ShellPane[]>(loadStoredShellPanes);
  const [demotingPaneIds, setDemotingPaneIds] = useState<Set<string>>(new Set());
  const demotedShellPaneIdsRef = useRef<Set<string>>(new Set());
  const previousProcessesRef = useRef<Map<string, DetectedProcess>>(new Map());
  const restoredPaneIdsRef = useRef<Set<string>>(new Set());
  const validatingRestoredPaneIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    saveStoredShellPanes(shellPanes);
  }, [shellPanes]);

  const checkDeadShellPanes = useCallback(() => {
    if (shellPanes.length === 0) return;
    Promise.all(
      shellPanes.map(async (pane) => {
        const info = await invoke<ExistingPaneInfo | null>("get_existing_pane_info", { paneId: pane.pane_id }).catch(() => null);
        return { pane_id: pane.pane_id, exists: !!info };
      }),
    ).then((results) => {
      const deadIds = new Set(results.filter((r) => !r.exists).map((r) => r.pane_id));
      if (deadIds.size > 0) {
        for (const paneId of deadIds) demotedShellPaneIdsRef.current.delete(paneId);
        setShellPanes((prev) => prev.filter((p) => !deadIds.has(p.pane_id)));
      }
    });
  }, [shellPanes, demotedShellPaneIdsRef]);

  const questionPolling = useQuestionPolling({ onTick: checkDeadShellPanes });
  const { questions, startFastQuestionPoll } = questionPolling;

  const autoYes = useAutoYes(questions, core.processes, core.jobs as Job[], startFastQuestionPoll);

  useEffect(() => {
    if (!split.tree && shellPanes.length === 0) return;

    const paneIds = new Set<string>([
      ...shellPanes.map((pane) => pane.pane_id),
      ...terminalLeafContents(split.tree).map((content) => content.paneId),
    ]);
    const unverifiedPaneIds = Array.from(paneIds).filter((paneId) => !restoredPaneIdsRef.current.has(paneId));
    if (unverifiedPaneIds.length === 0) return;

    for (const paneId of unverifiedPaneIds) {
      restoredPaneIdsRef.current.add(paneId);
      validatingRestoredPaneIdsRef.current.add(paneId);
    }

    let cancelled = false;
    Promise.all(
      unverifiedPaneIds.map(async (paneId): Promise<ShellPane | null> => {
        const existing = shellPanes.find((pane) => pane.pane_id === paneId);
        const info = await invoke<ExistingPaneInfo | null>("get_existing_pane_info", { paneId }).catch(() => null);
        if (!info) return null;
        return {
          pane_id: info.pane_id,
          cwd: info.cwd,
          tmux_session: info.tmux_session,
          window_name: info.window_name,
          matched_group: existing?.matched_group ?? null,
          display_name: existing?.display_name ?? null,
        };
      }),
    ).then((results) => {
      for (const paneId of unverifiedPaneIds) validatingRestoredPaneIdsRef.current.delete(paneId);
      if (cancelled) return;
      const restored = results.filter(isShellPane);
      const restoredIds = new Set(restored.map((pane) => pane.pane_id));
      const missingIds = new Set(unverifiedPaneIds.filter((paneId) => !restoredIds.has(paneId)));

      if (restored.length > 0) {
        for (const paneId of restoredIds) demotedShellPaneIdsRef.current.add(paneId);
        setShellPanes((prev) => {
          const next = [...prev];
          for (const pane of restored) {
            const index = next.findIndex((existing) => existing.pane_id === pane.pane_id);
            if (index >= 0) next[index] = { ...next[index], ...pane };
            else next.push(pane);
          }
          return next;
        });
      }

      if (missingIds.size > 0) {
        setShellPanes((prev) => prev.filter((pane) => !missingIds.has(pane.pane_id)));
      }
    });

    return () => { cancelled = true; };
  }, [shellPanes, split.tree]);

  // Clear stopping job slugs when job is no longer running
  useEffect(() => {
    if (stoppingJobSlugs.size === 0) return;
    const next = new Set<string>();
    for (const slug of stoppingJobSlugs) {
      if (core.statuses[slug]?.state === "running") next.add(slug);
    }
    if (next.size !== stoppingJobSlugs.size) setStoppingJobSlugs(next);
  }, [core.statuses, stoppingJobSlugs]);

  // Pane ids that disappeared from core.processes this tick and are candidates for
  // demotion to shell.
  const demotionCandidateIds = useMemo(() => {
    const previous = previousProcessesRef.current;
    const currentIds = new Set(core.processes.map((p) => p.pane_id));
    const shellIds = new Set(shellPanes.map((p) => p.pane_id));
    const stoppingIds = new Set(stoppingProcesses.map((e) => e.process.pane_id));
    const out = new Set<string>();
    for (const process of previous.values()) {
      if (currentIds.has(process.pane_id)) continue;
      if (shellIds.has(process.pane_id)) continue;
      if (stoppingIds.has(process.pane_id)) continue;
      if (process.pane_id === pendingProcess?.pane_id) continue;
      out.add(process.pane_id);
    }
    return out;
  }, [core.processes, shellPanes, stoppingProcesses, pendingProcess]);

  // Never clear viewingProcess while its pane_id still exists anywhere in the UI
  useEffect(() => {
    if (!viewingProcess) return;
    if (viewingProcess.pane_id.startsWith("_pending_")) return;
    const fresh = core.processes.find((p) => p.pane_id === viewingProcess.pane_id);
    if (fresh) {
      if (fresh !== viewingProcess) setViewingProcess(fresh);
      return;
    }
    if (demotingPaneIds.has(viewingProcess.pane_id)) return;
    if (demotionCandidateIds.has(viewingProcess.pane_id)) return;
    if (shellPanes.some((s) => s.pane_id === viewingProcess.pane_id)) return;
    const awaitingDetection =
      !!pendingAgentWorkDir && pendingProcess?.pane_id === viewingProcess.pane_id;
    if (awaitingDetection) return;
    setViewingProcess(null);
  }, [
    core.processes, viewingProcess, pendingAgentWorkDir, pendingProcess,
    demotingPaneIds, demotionCandidateIds, shellPanes, setViewingProcess,
  ]);

  // Keep viewingShell fresh or clear if it became a process again
  useEffect(() => {
    if (!viewingShell) return;
    const fresh = shellPanes.find((p) => p.pane_id === viewingShell.pane_id);
    if (!fresh) {
      if (core.processes.some((p) => p.pane_id === viewingShell.pane_id)) return;
      setViewingShell(null);
    }
    else if (fresh !== viewingShell) setViewingShell(fresh);
  }, [core.processes, shellPanes, viewingShell, setViewingShell]);

  // Main demotion effect: detect removed processes and demote to shell panes
  useEffect(() => {
    const previous = previousProcessesRef.current;
    const currentMap = new Map(core.processes.map((process) => [process.pane_id, process]));
    const stoppingIds = new Set(stoppingProcesses.map((entry) => entry.process.pane_id));
    const shellPaneIds = new Set(shellPanes.map((pane) => pane.pane_id));
    const removed = Array.from(previous.values()).filter((process) =>
      !currentMap.has(process.pane_id)
      && !stoppingIds.has(process.pane_id)
      && process.pane_id !== pendingProcess?.pane_id
      && !shellPaneIds.has(process.pane_id),
    );

    previousProcessesRef.current = currentMap;

    if (removed.length === 0) return;

    let cancelled = false;
    const removedIds = new Set(removed.map((process) => process.pane_id));
    setDemotingPaneIds((prev) => {
      const next = new Set(prev);
      for (const paneId of removedIds) next.add(paneId);
      return next;
    });

    Promise.all(
      removed.map(async (process): Promise<ShellPane | null> => {
        const info = await invoke<ExistingPaneInfo | null>("get_existing_pane_info", { paneId: process.pane_id }).catch(() => null);
        if (!info) return null;
        const shell: ShellPane = {
          pane_id: info.pane_id,
          cwd: info.cwd,
          tmux_session: info.tmux_session,
          window_name: info.window_name,
          matched_group: process.matched_group ?? null,
          display_name: process.display_name ?? null,
        };
        return shell;
      }),
    ).then((results) => {
      if (cancelled) return;
      const demoted = results.filter(isShellPane);
      const demotedIds = new Set(demoted.map((shell) => shell.pane_id));
      const vanishedIds = new Set(Array.from(removedIds).filter((paneId) => !demotedIds.has(paneId)));
      for (const paneId of demotedIds) {
        demotedShellPaneIdsRef.current.add(paneId);
      }
      setDemotingPaneIds((prev) => {
        const next = new Set(prev);
        for (const paneId of removedIds) next.delete(paneId);
        return next;
      });
      if (demoted.length === 0) return;

      setShellPanes((prev) => {
        const existing = new Set(prev.map((pane) => pane.pane_id));
        const additions = demoted.filter((shell) => !existing.has(shell.pane_id));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });

      for (const shell of demoted) {
        split.replaceContent(
          { kind: "process", paneId: shell.pane_id },
          { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session },
          { focus: false },
        );
      }

      const activeContent = split.tree
        ? (collectLeaves(split.tree).find((leaf) => leaf.id === split.focusedLeafId)?.content ?? currentContent)
        : currentContent;
      const activeDemotedShell = activeContent?.kind === "process"
        ? demoted.find((entry) => entry.pane_id === activeContent.paneId)
        : null;
      if (activeDemotedShell) {
        requestXtermPaneFocus(activeDemotedShell.pane_id);
        setViewingJob(null);
        setViewingAgent(false);
        setViewingProcess(null);
        setViewingShell(activeDemotedShell);
        setScrollToSlug(activeDemotedShell.pane_id);
      } else if (viewingProcess && demotedIds.has(viewingProcess.pane_id)) {
        const shell = demoted.find((entry) => entry.pane_id === viewingProcess.pane_id);
        if (shell) {
          setViewingProcess(null);
          setViewingShell(shell);
          setScrollToSlug(shell.pane_id);
        }
      } else if (viewingProcess && vanishedIds.has(viewingProcess.pane_id)) {
        setViewingProcess(null);
      }
    });

    return () => {
      cancelled = true;
      setDemotingPaneIds((prev) => {
        const next = new Set(prev);
        for (const paneId of removedIds) next.delete(paneId);
        return next;
      });
    };
  }, [core.processes, currentContent, pendingProcess, shellPanes, split.focusedLeafId, split.replaceContent, split.tree, stoppingProcesses, viewingProcess, setViewingJob, setViewingAgent, setViewingProcess, setViewingShell, setScrollToSlug]);

  // Agent process detection: match pending agent to real detected process
  useEffect(() => {
    if (!pendingAgentWorkDir) return;
    const { dir, startedAt } = pendingAgentWorkDir;
    const pendingPaneIdValue = pendingProcess && !pendingProcess.pane_id.startsWith("_pending_") ? pendingProcess.pane_id : null;
    const match = core.processes.find((p) =>
      pendingPaneIdValue
        ? p.pane_id === pendingPaneIdValue
        : (p.cwd === dir && !p.pane_id.startsWith("_pending_") &&
           p.session_started_at && new Date(p.session_started_at).getTime() >= startedAt - 5000),
    );
    if (match) {
      setPendingAgentWorkDir(null);
      setPendingProcess(null);
      if (split.tree) {
        const matchContent: PaneContent = { kind: "process", paneId: match.pane_id };
        const pendingContent = pendingProcess ? { kind: "process" as const, paneId: pendingProcess.pane_id } : null;
        if (!pendingContent || !split.replaceContent(pendingContent, matchContent, { focus: false })) {
          split.openContent(matchContent);
        }
      } else {
        setViewingProcess(match);
      }
      setScrollToSlug(match.pane_id);
      return;
    }
    if (Date.now() - startedAt > 15000) {
      setPendingAgentWorkDir(null);
      setPendingProcess(null);
    }
  }, [core.processes, pendingAgentWorkDir, pendingProcess, split.tree, split.openContent, split.replaceContent, setViewingProcess, setScrollToSlug]);

  // Cleanup stopping processes after timeout
  useEffect(() => {
    if (stoppingProcesses.length === 0) return;
    const MIN_STOPPING_VISIBLE_MS = 1500;
    const MAX_STOPPING_VISIBLE_MS = 10000;
    setStoppingProcesses((prev) =>
      prev.filter((sp) => {
        const stillPresent = core.processes.some((p) => p.pane_id === sp.process.pane_id);
        const elapsed = Date.now() - sp.stoppedAt;
        if (elapsed >= MAX_STOPPING_VISIBLE_MS) return false;
        if (stillPresent) return true;
        return elapsed < MIN_STOPPING_VISIBLE_MS;
      }),
    );
  }, [core.processes, stoppingProcesses.length]);

  // Clean stale process leaves from tree
  useEffect(() => {
    if (!core.loaded) return;
    split.cleanStaleLeaves((content) => {
      if (content.kind === "process") {
        if (pendingProcess?.pane_id === content.paneId) return false;
        if (demotingPaneIds.has(content.paneId)) return false;
        if (demotionCandidateIds.has(content.paneId)) return false;
        if (shellPanes.find((p) => p.pane_id === content.paneId)) return false;
        return !core.processes.find(p => p.pane_id === content.paneId);
      }
      if (content.kind === "terminal") {
        if (demotingPaneIds.has(content.paneId)) return false;
        if (demotionCandidateIds.has(content.paneId)) return false;
        if (demotedShellPaneIdsRef.current.has(content.paneId)) return false;
        if (validatingRestoredPaneIdsRef.current.has(content.paneId)) return false;
        return !shellPanes.find((p) => p.pane_id === content.paneId);
      }
      return false;
    });
  }, [core.processes, core.loaded, split.cleanStaleLeaves, pendingProcess, shellPanes, demotingPaneIds, demotionCandidateIds]);

  // Promote shell panes to detected processes when claude/codex is launched inside them
  useEffect(() => {
    if (core.processes.length === 0 || shellPanes.length === 0) return;
    const processPaneIds = new Set(core.processes.map((p) => p.pane_id));
    const promoted = shellPanes.filter((s) => processPaneIds.has(s.pane_id));
    if (promoted.length === 0) return;
    const promotedIds = new Set(promoted.map((s) => s.pane_id));
    const activeContent = split.tree
      ? (collectLeaves(split.tree).find((leaf) => leaf.id === split.focusedLeafId)?.content ?? currentContent)
      : currentContent;
    const activePromotedShell = activeContent?.kind === "terminal"
      ? promoted.find((shell) => shell.pane_id === activeContent.paneId)
      : null;
    if (activePromotedShell) {
      requestXtermPaneFocus(activePromotedShell.pane_id);
    }
    for (const paneId of promotedIds) {
      demotedShellPaneIdsRef.current.delete(paneId);
    }
    for (const shell of promoted) {
      split.replaceContent(
        { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session },
        { kind: "process", paneId: shell.pane_id },
        { focus: false },
      );
    }
    setShellPanes((prev) => prev.filter((s) => !promotedIds.has(s.pane_id)));
  }, [core.processes, currentContent, shellPanes, split.focusedLeafId, split.replaceContent, split.tree]);

  return {
    pendingProcess, setPendingProcess,
    stoppingProcesses, setStoppingProcesses,
    stoppingJobSlugs, setStoppingJobSlugs,
    shellPanes, setShellPanes,
    demotingPaneIds,
    demotedShellPaneIdsRef,
    pendingAgentWorkDir, setPendingAgentWorkDir,
    demotionCandidateIds,
    previousProcessesRef,
    questionPolling,
    autoYes,
  };
}
