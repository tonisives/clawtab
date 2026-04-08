import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import { JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared";

export type DragData =
  | { kind: "job"; slug: string; job: RemoteJob }
  | { kind: "process"; paneId: string; process?: ClaudeProcess; question?: ClaudeQuestion; resolvedJob?: string | null };

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
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({
    id: job.slug,
    data: { kind: "job", slug: job.slug, job, group } satisfies DragData & { group: string },
    disabled: !reorderEnabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        opacity: isDragging ? 0.4 : 1,
        cursor: "grab",
        touchAction: "none",
        outline: "none",
        transform: CSS.Transform.toString(transform),
        transition,
        borderRadius: 10,
      }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
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
        />
      )}
    </div>
  );
}

export function DraggableProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  onStop,
  onRename,
  autoYesActive,
}: {
  process: ClaudeProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  onStop?: () => void;
  onRename?: () => void;
  autoYesActive?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-process-${process.pane_id}`,
    data: { kind: "process", paneId: process.pane_id, process } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none", outline: "none" }}
      {...listeners}
      {...attributes}
      tabIndex={-1}
    >
      <ProcessCard
        process={process}
        onPress={onPress}
        inGroup={inGroup}
        selected={selected}
        onStop={onStop}
        onRename={onRename}
        autoYesActive={autoYesActive}
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
