import type { ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, PaneContent, ShellPane } from "@clawtab/shared";
import { JobCard, RunningJobCard, ProcessCard, ShellCard } from "@clawtab/shared";

export type DragData =
  | { kind: "job"; slug: string; job?: RemoteJob; source?: "sidebar" | "detail-pane" }
  | { kind: "process"; paneId: string; process?: DetectedProcess; question?: ClaudeQuestion; resolvedJob?: string | null; source?: "sidebar" | "detail-pane" }
  | { kind: "terminal"; paneId: string; tmuxSession: string; shell?: ShellPane; source?: "sidebar" | "detail-pane" }
  | { kind: "agent"; source?: "sidebar" | "detail-pane" };

export function DraggableJobCard({
  job,
  group,
  status,
  onPress,
  selected,
  onStop,
  autoYesActive,
  stopping,
  reorderEnabled,
  marginTop,
  dimmed,
  dataJobSlug,
  defaultAgentProvider,
}: {
  job: RemoteJob;
  group: string;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
  autoYesActive?: boolean;
  stopping?: boolean;
  reorderEnabled?: boolean;
  marginTop?: number;
  dimmed?: boolean;
  dataJobSlug?: string;
  defaultAgentProvider?: DetectedProcess["provider"];
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({
    id: job.slug,
    data: { kind: "job", slug: job.slug, job, group, source: "sidebar" } satisfies DragData & { group: string },
    disabled: !reorderEnabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: job.slug,
    data: { kind: "job-reorder-target", slug: job.slug, group },
    disabled: !reorderEnabled,
  });
  const setRefs = (node: HTMLDivElement | null) => {
    setNodeRef(node);
    setDropRef(node);
  };
  return (
    <div
      ref={setRefs}
      data-job-slug={dataJobSlug}
      style={{
        opacity: isDragging ? 0.4 : (dimmed ? 0.85 : 1),
        cursor: "grab",
        touchAction: "none",
        outline: "none",
        transform: CSS.Transform.toString(transform),
        transition,
        borderRadius: 10,
        marginTop,
        position: "relative",
      }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      {isOver && !isDragging ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            right: 10,
            top: -4,
            height: 2,
            borderRadius: 999,
            background: "var(--accent, #58a6ff)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ) : null}
      {status.state === "running" ? (
        <RunningJobCard
          job={job}
          status={status}
          onPress={onPress}
          selected={selected}
          onStop={onStop}
          autoYesActive={autoYesActive}
          stopping={stopping}
        />
      ) : (
        <JobCard
          job={job}
          status={status}
          onPress={onPress}
          selected={selected}
          defaultAgentProvider={defaultAgentProvider}
        />
      )}
    </div>
  );
}

export function DraggableProcessCard({
  process,
  sortGroup,
  onPress,
  inGroup,
  selected,
  onStop,
  onRename,
  onSaveName,
  autoYesActive,
  startRenameSignal,
  onRenameDraftChange,
  onRenameStateChange,
  reorderEnabled,
  marginTop,
  dataProcessId,
}: {
  process: DetectedProcess;
  sortGroup: string;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  onStop?: () => void;
  onRename?: () => void;
  onSaveName?: (name: string) => void;
  autoYesActive?: boolean;
  startRenameSignal?: number;
  onRenameDraftChange?: (value: string | null) => void;
  onRenameStateChange?: (editing: boolean) => void;
  reorderEnabled?: boolean;
  marginTop?: number;
  dataProcessId?: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({
    id: process.pane_id,
    data: { kind: "process", paneId: process.pane_id, process, sortGroup, source: "sidebar" } satisfies DragData & { sortGroup: string },
    disabled: !reorderEnabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: process.pane_id,
    data: { kind: "process-reorder-target", paneId: process.pane_id, sortGroup },
    disabled: !reorderEnabled,
  });
  const setRefs = (node: HTMLDivElement | null) => {
    setNodeRef(node);
    setDropRef(node);
  };

  return (
    <div
      ref={setRefs}
      data-process-id={dataProcessId}
      style={{
        opacity: isDragging ? 0.4 : 1,
        cursor: "grab",
        touchAction: "none",
        outline: "none",
        transform: CSS.Transform.toString(transform),
        transition,
        marginTop,
        borderRadius: 10,
        position: "relative",
      }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      {isOver && !isDragging ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            right: 10,
            top: -4,
            height: 2,
            borderRadius: 999,
            background: "var(--accent, #58a6ff)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ) : null}
      <ProcessCard
        process={process}
        onPress={onPress}
        inGroup={inGroup}
        selected={selected}
        onStop={onStop}
        onRename={onRename}
        onSaveName={onSaveName}
        autoYesActive={autoYesActive}
        startRenameSignal={startRenameSignal}
        onRenameDraftChange={onRenameDraftChange}
        onRenameStateChange={onRenameStateChange}
      />
    </div>
  );
}

export function DraggableNotificationCard({
  question,
  resolvedJob,
  children,
}: {
  question: ClaudeQuestion;
  resolvedJob: string | null;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-question-${question.question_id}`,
    data: {
      kind: "process",
      paneId: question.pane_id,
      question,
      resolvedJob,
      source: "sidebar",
    } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none", outline: "none" }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export function DraggableShellCard({
  shell,
  onPress,
  selected,
  onStop,
}: {
  shell: ShellPane;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `shell-${shell.pane_id}`,
    data: {
      kind: "terminal",
      paneId: shell.pane_id,
      tmuxSession: shell.tmux_session,
      shell,
      source: "sidebar",
    } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none", outline: "none" }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      <ShellCard shell={shell} onPress={onPress} selected={selected} onStop={onStop} />
    </div>
  );
}

function dragDataForPane(content: PaneContent): DragData {
  if (content.kind === "job") return { kind: "job", slug: content.slug, source: "detail-pane" };
  if (content.kind === "process") return { kind: "process", paneId: content.paneId, source: "detail-pane" };
  if (content.kind === "terminal") return { kind: "terminal", paneId: content.paneId, tmuxSession: content.tmuxSession, source: "detail-pane" };
  return { kind: "agent", source: "detail-pane" };
}

export function DraggableSplitPane({
  leafId,
  content,
  children,
}: {
  leafId: string;
  content: PaneContent;
  children: (dragHandleProps: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: any;
    listeners?: any;
    isDragging?: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, isDragging } = useDraggable({
    id: `detail-pane-${leafId}`,
    data: dragDataForPane(content),
  });

  return (
    <>
      {children({
        ref: setActivatorNodeRef,
        attributes,
        listeners,
        isDragging,
      })}
    </>
  );
}
