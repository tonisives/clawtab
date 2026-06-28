import type { ReactNode } from "react";
import { Platform, Text, View } from "react-native";

import { spacing } from "../../theme/spacing";
import type { GroupedRowPosition, ListItem } from "./sign";
import { JobListGroupAgentItem } from "./GroupAgentItem";
import { JobListHeaderItem } from "./HeaderItem";
import { JobListHiddenHeader } from "./HiddenHeader";
import { JobListHiddenSection } from "./HiddenSection";
import { JobListJobItem } from "./JobItem";
import { JobListProcessItem } from "./ProcessItem";
import { JobListShellItem } from "./ShellItem";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListItemsProps {
  hook: JobListViewHook;
}

export function JobListItems({ hook }: JobListItemsProps) {
  if (hook.items.length === 0 && (hook.showEmpty || hook.query)) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{hook.query ? "No matches" : "No jobs"}</Text>
        <Text style={styles.emptyText}>{hook.query ? `No jobs or groups matching "${hook.searchQuery}"` : hook.emptyMessage}</Text>
      </View>
    );
  }

  const rendered: ReactNode[] = [];
  let index = 0;
  let currentGroupBuffer: ReactNode[] | null = null;
  let currentGroupIsActive = false;
  let currentGroupKey: string | null = null;
  let prevFlushedWasActive = false;
  const flushGroup = () => {
    if (!currentGroupBuffer) return;
    const buffer = currentGroupBuffer;
    const isActive = currentGroupIsActive;
    const groupKey = currentGroupKey;
    currentGroupBuffer = null;
    currentGroupIsActive = false;
    currentGroupKey = null;
    if (isActive) {
      const isFirst = rendered.length === 0;
      const isCollapsed = groupKey != null && hook.collapsedGroups.has(groupKey);
      rendered.push(
        <View
          key={`wsgroup_${groupKey}`}
          style={[
            styles.activeWorkspaceGroup,
            { marginTop: isFirst ? 18 : 18 + spacing.sm / 2 },
            isCollapsed ? null : { paddingBottom: spacing.sm / 2 + 5 },
          ]}
        >
          {buffer}
        </View>,
      );
      prevFlushedWasActive = true;
    } else {
      rendered.push(...buffer);
      prevFlushedWasActive = false;
    }
  };
  const pushToGroup = (node: ReactNode) => {
    if (currentGroupBuffer) {
      currentGroupBuffer.push(node);
    } else {
      rendered.push(node);
    }
  };
  const keyCounts = new Map<string, number>();
  const uniqueKey = (base: string) => {
    const count = keyCounts.get(base) ?? 0;
    keyCounts.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  };
  const groupedPosition = (offset: number, count: number): GroupedRowPosition => {
    if (count <= 1) return "single";
    if (offset === 0) return "first";
    if (offset === count - 1) return "last";
    return "middle";
  };
  const wrapRows = (key: string, children: ReactNode) => (
    Platform.OS === "web"
      ? <View key={key} style={styles.webGroupedRows}>{children}</View>
      : <View key={key} style={styles.nativeGroupedRows}>{children}</View>
  );

  while (index < hook.items.length) {
    const item = hook.items[index];
    if (item.kind === "job") {
      const jobItems: Extract<ListItem, { kind: "job" }>[] = [];
      while (index < hook.items.length && hook.items[index]?.kind === "job") {
        jobItems.push(hook.items[index] as Extract<ListItem, { kind: "job" }>);
        index += 1;
      }
      const children = jobItems.map((jobItem, offset) => (
        <JobListJobItem
          key={`j_${jobItem.job.slug || jobItem.job.name}`}
          hook={hook}
          item={jobItem}
          itemKey={`j_${jobItem.job.slug || jobItem.job.name}`}
          groupedPosition={groupedPosition(offset, jobItems.length)}
        />
      ));
      const group = jobItems[0]?.job.group || "default";
      const jobSlugs = jobItems.map((jobItem) => jobItem.job.slug);
      const groupKey = uniqueKey(`job_group_${group}`);
      pushToGroup(
        hook.wrapJobGroup
          ? wrapRows(groupKey, hook.wrapJobGroup(group, jobSlugs, children))
          : wrapRows(groupKey, children),
      );
      continue;
    }

    if (item.kind === "process") {
      const processItems: Extract<ListItem, { kind: "process" }>[] = [];
      while (index < hook.items.length && hook.items[index]?.kind === "process") {
        processItems.push(hook.items[index] as Extract<ListItem, { kind: "process" }>);
        index += 1;
      }
      const children = processItems.map((processItem, offset) => (
        <JobListProcessItem
          key={`p_${processItem.process.pane_id}`}
          hook={hook}
          process={processItem.process}
          itemKey={`p_${processItem.process.pane_id}`}
          inGroup={processItem.inGroup}
          groupedPosition={groupedPosition(offset, processItems.length)}
        />
      ));
      const group = processItems[0]?.process.matched_group ?? `cwd:${processItems[0]?.process.cwd ?? ""}`;
      const processPaneIds = processItems.map((processItem) => processItem.process.pane_id);
      const groupKey = uniqueKey(`process_group_${group}`);
      pushToGroup(
        hook.wrapProcessGroup
          ? wrapRows(groupKey, hook.wrapProcessGroup(group, processPaneIds, children))
          : wrapRows(groupKey, children),
      );
      continue;
    }

    if (item.kind === "shell") {
      const shellItems: Extract<ListItem, { kind: "shell" }>[] = [];
      const startIndex = index;
      while (index < hook.items.length && hook.items[index]?.kind === "shell") {
        shellItems.push(hook.items[index] as Extract<ListItem, { kind: "shell" }>);
        index += 1;
      }
      const children = shellItems.map((shellItem, offset) => (
        <JobListShellItem
          key={`s_${shellItem.shell.pane_id}`}
          hook={hook}
          shell={shellItem.shell}
          itemKey={`s_${shellItem.shell.pane_id}`}
          index={startIndex + offset}
          groupedPosition={groupedPosition(offset, shellItems.length)}
        />
      ));
      pushToGroup(wrapRows(uniqueKey("shell_group"), children));
      continue;
    }

    const key =
      item.kind === "header"
        ? `h_${item.group}`
        : item.kind === "group-agent"
            ? uniqueKey(`ga_${item.workDir}`)
            : item.kind === "hidden-section"
              ? "hidden_section"
              : `hh_${item.group}`;
    const prevWasActive = prevFlushedWasActive;
    if (item.kind === "header" || item.kind === "hidden-section" || item.kind === "hidden-header") {
      flushGroup();
      if (item.kind === "header") {
        const isWorkspaceHeaderForFlush = hook.activeWorkspaceId != null && item.group !== "Shells";
        if (isWorkspaceHeaderForFlush) {
          currentGroupBuffer = [];
          currentGroupIsActive = item.group === hook.activeWorkspaceId;
          currentGroupKey = item.group;
        }
      }
    }
    pushToGroup(renderSingleItem(hook, item, key, index, prevWasActive));
    index += 1;
  }
  flushGroup();
  return rendered;
}

function renderSingleItem(
  hook: JobListViewHook,
  item: Exclude<ListItem, { kind: "job" | "process" | "shell" }>,
  key: string,
  index: number,
  prevWasActive: boolean,
) {
  if (item.kind === "header") {
    return <JobListHeaderItem key={key} hook={hook} item={item} itemKey={key} index={index} prevWasActive={prevWasActive} />;
  }
  if (item.kind === "group-agent") {
    return <JobListGroupAgentItem key={key} hook={hook} workDir={item.workDir} itemKey={key} />;
  }
  if (item.kind === "hidden-section") {
    return <JobListHiddenSection key={key} hook={hook} itemKey={key} />;
  }
  if (item.kind === "hidden-header") {
    return <JobListHiddenHeader key={key} hook={hook} item={item} itemKey={key} />;
  }
  return null;
}
