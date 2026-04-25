import type { ReactNode } from "react";
import type { PaneContent } from "@clawtab/shared";
import { AgentDetail } from "../../JobDetailSections";
import { DraggableSplitPane } from "../../DraggableCards";
import type { PaneContext } from "./paneTypes";

type DragHandleProps = {
  ref?: (node: HTMLElement | null) => void;
  attributes?: any;
  listeners?: any;
  isDragging?: boolean;
};

interface Props {
  content: Extract<PaneContent, { kind: "agent" }>;
  ctx: PaneContext;
}

export function AgentPane({ content, ctx }: Props) {
  const {
    transport, agentJob, agentProcess, core, split, viewing,
    isWide, headerLeftInset, mode, mgr, callbacks,
  } = ctx;

  const close = mode.kind === "leaf"
    ? () => split.handleClosePane(mode.leafId)
    : () => viewing.setViewingAgent(false);

  const zoom = mode.kind === "leaf"
    ? () => split.toggleZoomLeaf(mode.leafId)
    : () => split.toggleZoomLeaf("");

  const detail = (dragHandleProps?: DragHandleProps): ReactNode => (
    <AgentDetail
      transport={transport}
      job={agentJob}
      status={core.statuses["agent"] ?? { state: "idle" as const }}
      onBack={close}
      onOpen={() => callbacks.handleOpen("agent")}
      onEditTitle={agentProcess ? () => callbacks.openRenameProcessDialog(agentProcess) : undefined}
      onZoomPane={zoom}
      showBackButton={!isWide}
      hidePath
      headerLeftInset={headerLeftInset}
      titlePath={agentProcess ? callbacks.buildProcessTitlePath(agentProcess) : "Agent"}
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
