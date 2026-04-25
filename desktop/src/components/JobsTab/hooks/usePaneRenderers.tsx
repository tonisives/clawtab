import { useCallback, type RefObject } from "react";
import type { ClaudeQuestion, DetectedProcess, PaneContent, ProcessProvider, RemoteJob, Transport } from "@clawtab/shared";
import { useJobsCore, useJobActions, useSplitTree } from "@clawtab/shared";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";
import { PaneRouter, useLeafJobEditing, type PaneCallbacks, type PaneContext } from "../panes";
import type { useViewingState } from "./useViewingState";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useQuestionPolling } from "../../../hooks/useQuestionPolling";

interface UsePaneRenderersParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  actions: ReturnType<typeof useJobActions>;
  questions: ClaudeQuestion[];
  questionPolling: ReturnType<typeof useQuestionPolling>;
  autoYes: ReturnType<typeof useAutoYes>;
  transport: Transport;
  agentJob: RemoteJob;
  agentProcess: DetectedProcess | null;
  isWide: boolean;
  trafficLightInset: number;
  topLeftLeafId: string | null;
  defaultProvider: ProcessProvider;
  defaultModel?: string | null;
  enabledModels?: Record<string, string[]>;
  autoYesShortcut?: string;
  callbacks: PaneCallbacks;
  sidebarFocusRef: RefObject<{ focus: () => void } | null>;
}

export function usePaneRenderers(params: UsePaneRenderersParams) {
  const {
    core, split, viewing, lifecycle, actions,
    questions, questionPolling, autoYes, transport,
    agentJob, agentProcess,
    isWide, trafficLightInset, topLeftLeafId,
    defaultProvider, defaultModel, enabledModels,
    autoYesShortcut,
    callbacks,
    sidebarFocusRef,
  } = params;
  const mgr = useWorkspaceManager();
  const leafJobEditing = useLeafJobEditing(core, split);

  const buildCtx = useCallback((mode: PaneContext["mode"], headerLeftInset: number): PaneContext => ({
    mode,
    headerLeftInset,
    core, split, viewing, lifecycle, actions,
    questions, questionPolling, autoYes, transport,
    agentJob, agentProcess,
    isWide,
    defaultProvider, defaultModel, enabledModels,
    autoYesShortcut,
    callbacks,
    sidebarFocusRef,
    mgr,
    leafJobEditing,
  }), [
    core, split, viewing, lifecycle, actions,
    questions, questionPolling, autoYes, transport,
    agentJob, agentProcess, isWide,
    defaultProvider, defaultModel, enabledModels,
    autoYesShortcut, callbacks, sidebarFocusRef, mgr, leafJobEditing,
  ]);

  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    const headerLeftInset = leafId === topLeftLeafId ? trafficLightInset : 0;
    const ctx = buildCtx({ kind: "leaf", leafId }, headerLeftInset);
    return <PaneRouter content={content} ctx={ctx} />;
  }, [buildCtx, topLeftLeafId, trafficLightInset]);

  const renderSinglePaneContent = useCallback((content: PaneContent) => {
    const ctx = buildCtx({ kind: "single" }, trafficLightInset);
    return <PaneRouter content={content} ctx={ctx} />;
  }, [buildCtx, trafficLightInset]);

  return { renderLeaf, renderSinglePaneContent };
}
