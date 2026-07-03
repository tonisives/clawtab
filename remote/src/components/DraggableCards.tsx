import { useDraggable } from "@dnd-kit/core"
import type { RemoteJob, JobStatus } from "@clawtab/shared"
import type { DetectedProcess } from "@clawtab/shared"
import type { ProcessProvider } from "@clawtab/shared"
import { JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared"
import { Platform, View } from "react-native"

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
  onStop,
  onTogglePin,
  pinned,
  autoYesActive,
  stopping,
  defaultAgentProvider,
  groupedPosition,
}: {
  job: RemoteJob
  status: JobStatus
  onPress?: () => void
  selected?: boolean | string
  softBorder?: boolean
  onStop?: () => void
  onTogglePin?: () => void
  pinned?: boolean
  autoYesActive?: boolean
  stopping?: boolean
  defaultAgentProvider?: ProcessProvider
  groupedPosition?: "single" | "first" | "middle" | "last"
}) {
  if (Platform.OS !== "web") {
    const content = status.state === "running" ? (
      <RunningJobCard
        job={job}
        status={status}
        onPress={onPress}
        selected={selected}
        softBorder={softBorder}
        onStop={onStop}
        onTogglePin={onTogglePin}
        pinned={pinned}
        autoYesActive={autoYesActive}
        stopping={stopping}
        defaultAgentProvider={defaultAgentProvider}
        groupedPosition={groupedPosition}
      />
    ) : (
      <JobCard
        job={job}
        status={status}
        onPress={onPress}
        onTogglePin={onTogglePin}
        pinned={pinned}
        selected={selected}
        softBorder={softBorder}
        defaultAgentProvider={defaultAgentProvider}
        groupedPosition={groupedPosition}
      />
    )

    return <View>{content}</View>
  }

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
        <RunningJobCard
          job={job}
          status={status}
          onPress={onPress}
          selected={selected}
          softBorder={softBorder}
          onStop={onStop}
          onTogglePin={onTogglePin}
          pinned={pinned}
          autoYesActive={autoYesActive}
          stopping={stopping}
          defaultAgentProvider={defaultAgentProvider}
          groupedPosition={groupedPosition}
        />
      ) : (
        <JobCard
          job={job}
          status={status}
          onPress={onPress}
          onTogglePin={onTogglePin}
          pinned={pinned}
          selected={selected}
          softBorder={softBorder}
          defaultAgentProvider={defaultAgentProvider}
          groupedPosition={groupedPosition}
        />
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
  onStop,
  onTogglePin,
  pinned,
  autoYesActive,
  groupedPosition,
}: {
  process: DetectedProcess
  onPress?: () => void
  inGroup?: boolean
  selected?: boolean | string
  softBorder?: boolean
  onStop?: () => void
  onTogglePin?: () => void
  pinned?: boolean
  autoYesActive?: boolean
  groupedPosition?: "single" | "first" | "middle" | "last"
}) {
  if (Platform.OS !== "web") {
    return (
      <View>
        <ProcessCard
          process={process}
          onPress={onPress}
          inGroup={inGroup}
          selected={selected}
          softBorder={softBorder}
          onStop={onStop}
          onTogglePin={onTogglePin}
          pinned={pinned}
          autoYesActive={autoYesActive}
          groupedPosition={groupedPosition}
        />
      </View>
    )
  }

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
      <ProcessCard
        process={process}
        onPress={onPress}
        inGroup={inGroup}
        selected={selected}
        softBorder={softBorder}
        onStop={onStop}
        onTogglePin={onTogglePin}
        pinned={pinned}
        autoYesActive={autoYesActive}
        groupedPosition={groupedPosition}
      />
    </div>
  )
}
