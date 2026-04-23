import { useDraggable } from "@dnd-kit/core"
import type { RemoteJob, JobStatus } from "@clawtab/shared"
import type { DetectedProcess } from "@clawtab/shared"
import { JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared"

export type DragData =
  | { kind: "job"; slug: string; job: RemoteJob }
  | { kind: "process"; paneId: string; process: DetectedProcess }

// Use plain div since @dnd-kit spreads DOM-specific attributes that
// conflict with React Native View types. Web wide-mode only.

export function DraggableJobCard({
  job,
  status,
  onPress,
  selected,
  softBorder,
}: {
  job: RemoteJob
  status: JobStatus
  onPress?: () => void
  selected?: boolean | string
  softBorder?: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-job-${job.slug}`,
    data: { kind: "job", slug: job.slug, job } satisfies DragData,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      {status.state === "running" ? (
        <RunningJobCard job={job} status={status} onPress={onPress} selected={selected} softBorder={softBorder} />
      ) : (
        <JobCard job={job} status={status} onPress={onPress} selected={selected} softBorder={softBorder} />
      )}
    </div>
  )
}

export function DraggableProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  softBorder,
}: {
  process: DetectedProcess
  onPress?: () => void
  inGroup?: boolean
  selected?: boolean | string
  softBorder?: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-process-${process.pane_id}`,
    data: { kind: "process", paneId: process.pane_id, process } satisfies DragData,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      <ProcessCard process={process} onPress={onPress} inGroup={inGroup} selected={selected} softBorder={softBorder} />
    </div>
  )
}
