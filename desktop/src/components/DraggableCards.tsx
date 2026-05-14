import type { ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, PaneContent, ShellPane } from "@clawtab/shared";
import { JobCard, RunningJobCard, ProcessCard, ShellCard } from "@clawtab/shared";

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M10.5 1.5l4 4-2 1-3.5 3.5 1 3-2 1-3-3-3.5 3.5-1-1 3.5-3.5-3-3 1-2 3 1 3.5-3.5z" />
    </svg>
  );
}

function PinButton({
  pinned,
  onToggle,
  inFrame,
}: {
  pinned: boolean;
  onToggle: () => void;
  inFrame?: boolean;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      title={pinned ? "Unpin" : "Pin to top"}
      style={{
        ...(inFrame
          ? { width: 18, height: 18 }
          : { position: "absolute", top: 8, right: 28, width: 14, height: 14, zIndex: 6 }),
        borderRadius: 4,
        border: "none",
        background: "transparent",
        color: pinned ? "var(--accent, #58a6ff)" : "rgba(255,255,255,0.5)",
        padding: 0,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
      }}
    >
      <PinIcon filled={pinned} />
    </button>
  );
}

function ShellControlsFrame({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 30,
        height: 18,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        zIndex: 6,
        pointerEvents: "auto",
      }}
    >
      <PinButton pinned={pinned} onToggle={onTogglePin} inFrame />
    </div>
  );
}

export type DragData =
  | { kind: "job"; slug: string; job?: RemoteJob; source?: "sidebar" | "detail-pane"; sourceWorkspaceId?: string }
  | { kind: "process"; paneId: string; process?: DetectedProcess; question?: ClaudeQuestion; resolvedJob?: string | null; source?: "sidebar" | "detail-pane"; sourceWorkspaceId?: string }
  | { kind: "terminal"; paneId: string; tmuxSession: string; shell?: ShellPane; source?: "sidebar" | "detail-pane"; sourceWorkspaceId?: string }
  | { kind: "agent"; source?: "sidebar" | "detail-pane"; sourceWorkspaceId?: string };

export function DraggableJobCard({
  job,
  group,
  status,
  onPress,
  selected,
  softBorder,
  onStop,
  autoYesActive,
  stopping,
  reorderEnabled,
  marginTop,
  dimmed,
  dataJobSlug,
  defaultAgentProvider,
  pinned,
  onTogglePin,
}: {
  job: RemoteJob;
  group: string;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  autoYesActive?: boolean;
  stopping?: boolean;
  reorderEnabled?: boolean;
  marginTop?: number;
  dimmed?: boolean;
  dataJobSlug?: string;
  defaultAgentProvider?: DetectedProcess["provider"];
  pinned?: boolean;
  onTogglePin?: () => void;
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
          softBorder={softBorder}
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
          softBorder={softBorder}
          defaultAgentProvider={defaultAgentProvider}
        />
      )}
      {onTogglePin ? <PinButton pinned={!!pinned} onToggle={onTogglePin} /> : null}
    </div>
  );
}

export function DraggableProcessCard({
  process,
  sortGroup,
  onPress,
  inGroup,
  selected,
  softBorder,
  onStop,
  onRename,
  onSaveName,
  autoYesActive,
  startRenameSignal,
  onRenameDraftChange,
  onRenameStateChange,
  renameShortcutHint,
  reorderEnabled,
  marginTop,
  dataProcessId,
  onMoveToWorkspace,
  moveToWorkspaceLabel,
  pinned,
  onTogglePin,
}: {
  process: DetectedProcess;
  sortGroup: string;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  onRename?: () => void;
  onSaveName?: (name: string) => void;
  autoYesActive?: boolean;
  startRenameSignal?: number;
  onRenameDraftChange?: (value: string | null) => void;
  onRenameStateChange?: (editing: boolean) => void;
  renameShortcutHint?: string;
  reorderEnabled?: boolean;
  marginTop?: number;
  dataProcessId?: string;
  onMoveToWorkspace?: () => void;
  moveToWorkspaceLabel?: string;
  pinned?: boolean;
  onTogglePin?: () => void;
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
        softBorder={softBorder}
        onStop={onStop}
        onRename={onRename}
        onSaveName={onSaveName}
        autoYesActive={autoYesActive}
        startRenameSignal={startRenameSignal}
        onRenameDraftChange={onRenameDraftChange}
        onRenameStateChange={onRenameStateChange}
        renameShortcutHint={renameShortcutHint}
        onMoveToWorkspace={onMoveToWorkspace}
        moveToWorkspaceLabel={moveToWorkspaceLabel}
      />
      {onTogglePin ? <PinButton pinned={!!pinned} onToggle={onTogglePin} /> : null}
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
  softBorder,
  onStop,
  onRename,
  renameShortcutHint,
  onMoveToWorkspace,
  moveToWorkspaceLabel,
  pinned,
  onTogglePin,
}: {
  shell: ShellPane;
  onPress?: () => void;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  onRename?: () => void;
  renameShortcutHint?: string;
  onMoveToWorkspace?: () => void;
  moveToWorkspaceLabel?: string;
  pinned?: boolean;
  onTogglePin?: () => void;
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
      data-shell-id={shell.pane_id}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none", outline: "none", position: "relative" }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      <ShellCard
        shell={shell}
        onPress={onPress}
        selected={selected}
        softBorder={softBorder}
        onStop={onStop}
        onRename={onRename}
        renameShortcutHint={renameShortcutHint}
        onMoveToWorkspace={onMoveToWorkspace}
        moveToWorkspaceLabel={moveToWorkspaceLabel}
      />
      {onTogglePin ? <ShellControlsFrame pinned={!!pinned} onTogglePin={onTogglePin} /> : null}
    </div>
  );
}

function dragDataForPane(content: PaneContent, sourceWorkspaceId?: string): DragData {
  if (content.kind === "job") return { kind: "job", slug: content.slug, source: "detail-pane", sourceWorkspaceId };
  if (content.kind === "process") return { kind: "process", paneId: content.paneId, source: "detail-pane", sourceWorkspaceId };
  if (content.kind === "terminal") return { kind: "terminal", paneId: content.paneId, tmuxSession: content.tmuxSession, source: "detail-pane", sourceWorkspaceId };
  return { kind: "agent", source: "detail-pane", sourceWorkspaceId };
}

export function DraggableSplitPane({
  leafId,
  content,
  sourceWorkspaceId,
  children,
}: {
  leafId: string;
  content: PaneContent;
  sourceWorkspaceId?: string;
  children: (dragHandleProps: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: any;
    listeners?: any;
    isDragging?: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, isDragging } = useDraggable({
    id: `detail-pane-${leafId}`,
    data: dragDataForPane(content, sourceWorkspaceId),
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
