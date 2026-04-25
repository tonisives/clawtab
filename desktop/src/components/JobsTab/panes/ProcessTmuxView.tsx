import type { ReactNode } from "react";
import type { DetectedProcess, PaneContent } from "@clawtab/shared";
import { TmuxPaneDetail } from "../../TmuxPaneDetail";
import { DraggableSplitPane } from "../../DraggableCards";
import type { PaneContext } from "./paneTypes";

type DragHandleProps = {
  ref?: (node: HTMLElement | null) => void;
  attributes?: any;
  listeners?: any;
  isDragging?: boolean;
};

interface Props {
  content: PaneContent;
  process: DetectedProcess;
  ctx: PaneContext;
}

export function ProcessTmuxView({ content, process, ctx }: Props) {
  const {
    questions, questionPolling, autoYes, autoYesShortcut,
    isWide, headerLeftInset, mode, split, viewing, core, lifecycle, callbacks, mgr,
  } = ctx;

  const close = mode.kind === "leaf"
    ? () => split.handleClosePane(mode.leafId)
    : () => viewing.setViewingProcess(null);

  const zoom = mode.kind === "leaf"
    ? () => split.toggleZoomLeaf(mode.leafId)
    : () => split.toggleZoomLeaf("");

  const onStopped = () => {
    lifecycle.setStoppingProcesses((prev) => {
      if (prev.some((sp) => sp.process.pane_id === process.pane_id)) return prev;
      return [...prev, { process: { ...process, _transient_state: "stopping" }, stoppedAt: Date.now() }];
    });
    core.requestFastPoll(`pane:${process.pane_id}`);
    if (mode.kind === "single") callbacks.selectAdjacentItem(process.pane_id);
  };

  const onToggleAutoYes = () => {
    const paneQuestion = questions.find((q) => q.pane_id === process.pane_id);
    if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
    else autoYes.handleToggleAutoYesByPaneId(process.pane_id, process.cwd.replace(/^\/Users\/[^/]+/, "~"));
  };

  const detail = (dragHandleProps?: DragHandleProps): ReactNode => (
    <TmuxPaneDetail
      target={{ kind: "process", process }}
      questions={questions}
      onBack={close}
      onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
      autoYesActive={autoYes.autoYesPaneIds.has(process.pane_id)}
      onToggleAutoYes={onToggleAutoYes}
      autoYesShortcut={autoYesShortcut}
      showBackButton={!isWide}
      hidePath
      onStopped={onStopped}
      onFork={(direction) => callbacks.handleFork(process.pane_id, direction)}
      onSplitPane={(direction) => callbacks.handleSplitPane(process.pane_id, direction)}
      onZoomPane={zoom}
      onInjectSecrets={() => callbacks.setInjectSecretsPaneId(process.pane_id)}
      onSearchSkills={() => callbacks.setSkillSearchPaneId(process.pane_id)}
      headerLeftInset={headerLeftInset}
      titlePath={callbacks.buildProcessTitlePath(process)}
      displayNameOverride={callbacks.processRenameDrafts[process.pane_id] ?? null}
      dragHandleProps={dragHandleProps}
    />
  );

  if (mode.kind === "leaf") {
    return (
      <DraggableSplitPane leafId={mode.leafId} content={content} sourceWorkspaceId={mgr.activeId}>
        {(dragHandleProps) => detail(dragHandleProps)}
      </DraggableSplitPane>
    );
  }
  return <>{detail()}</>;
}
