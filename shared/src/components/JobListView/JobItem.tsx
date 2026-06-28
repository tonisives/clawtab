import { Platform, Text, TouchableOpacity, View } from "react-native";

import type { ListItem } from "./sign";
import type { GroupedRowPosition } from "./sign";
import { IDLE_STATUS } from "./sign";
import { JobCard } from "../JobCard";
import { RunningJobCard } from "../RunningJobCard";
import { JobListProcessItem } from "./ProcessItem";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListJobItemProps {
  hook: JobListViewHook;
  item: Extract<ListItem, { kind: "job" }>;
  itemKey: string;
  groupedPosition?: GroupedRowPosition;
}

export function JobListJobItem({ hook, item, itemKey, groupedPosition }: JobListJobItemProps) {
  const status = hook.statuses[item.job.slug] ?? IDLE_STATUS;
  const onPress = hook.onSelectJob ? () => hook.onSelectJob?.(item.job) : undefined;
  const rawJobColor = hook.selectedItems?.get(item.job.slug);
  const isJobFocused = !hook.focusedItemKey || hook.focusedItemKey === item.job.slug;
  const selected: boolean | string = rawJobColor
    ? (isJobFocused ? rawJobColor : rawJobColor + "66")
    : (hook.selectedSlug === item.job.slug);
  const openElsewhere = hook.openElsewhereContentKeys?.has(`job:${item.job.slug}`) ?? false;
  const softBorder = openElsewhere && !selected;
  const isRunning = status.state === "running";
  const jobPaneId = isRunning ? (status as { pane_id?: string }).pane_id : undefined;
  const autoYesActive = jobPaneId ? hook.autoYesPaneIds?.has(jobPaneId) ?? false : false;
  const stopping = hook.stoppingSlugsExternal?.has(item.job.slug) ?? false;
  const onStop = isRunning && !stopping && hook.onStopJob ? () => hook.onStopJob?.(item.job.slug) : undefined;
  const marginTop = Platform.OS === "web" && groupedPosition && groupedPosition !== "single" && groupedPosition !== "first" ? -1 : undefined;
  const dimmed = item.idx % 2 === 1;
  const childProcesses = hook.matchedProcessesByJob.get(item.job.slug) ?? [];
  const hasChildProcesses = childProcesses.length > 0;
  const childProcessesExpanded = hasChildProcesses && !hook.collapsedJobPanes.has(item.job.slug);
  const expandToggle = hasChildProcesses ? (
    <TouchableOpacity
      onPress={(event: any) => {
        event.stopPropagation?.();
        hook.toggleJobPanes(item.job.slug);
      }}
      style={styles.jobPaneToggle}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Text style={styles.jobPaneToggleText}>
        {childProcessesExpanded ? "\u25BE" : "\u25B8"}
      </Text>
    </TouchableOpacity>
  ) : null;

  return (
    <View key={itemKey}>
      <View style={styles.jobWithPaneToggle}>
        {hook.customRenderJobCard ? (
          hook.customRenderJobCard({
            job: item.job,
            group: item.job.group || "default",
            indexInGroup: item.idx,
            status,
            onPress,
            selected,
            softBorder,
            onStop,
            autoYesActive,
            stopping,
            marginTop,
            dimmed,
            dataJobSlug: item.job.slug,
            defaultAgentProvider: hook.defaultAgentProvider,
            groupedPosition,
          })
        ) : (
          <View
            {...(Platform.OS === "web" ? { dataSet: { jobSlug: item.job.slug } } : {})}
            style={[
              dimmed ? { opacity: 0.85 } : undefined,
              marginTop != null ? { marginTop } : undefined,
            ]}
          >
            {status.state === "running" ? (
              <RunningJobCard
                job={item.job}
                status={status}
                onPress={onPress}
                selected={selected}
                softBorder={softBorder}
                onStop={onStop}
                autoYesActive={autoYesActive}
                stopping={stopping}
                defaultAgentProvider={hook.defaultAgentProvider}
                groupedPosition={groupedPosition}
              />
            ) : (
              <JobCard
                job={item.job}
                status={status}
                onPress={onPress}
                selected={selected}
                softBorder={softBorder}
                defaultAgentProvider={hook.defaultAgentProvider}
                groupedPosition={groupedPosition}
              />
            )}
          </View>
        )}
        {expandToggle}
      </View>
      {childProcessesExpanded ? (
        <View style={styles.jobChildProcesses}>
          {childProcesses.map((process, offset) => (
            <JobListProcessItem
              key={`job_${item.job.slug}_pane_${process.pane_id}`}
              hook={hook}
              process={process}
              itemKey={`job_${item.job.slug}_pane_${process.pane_id}`}
              inGroup
              sortGroup={`job:${item.job.slug}`}
              childOfJobSlug={item.job.slug}
              groupedPosition={childProcesses.length <= 1 ? "single" : offset === 0 ? "first" : offset === childProcesses.length - 1 ? "last" : "middle"}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
