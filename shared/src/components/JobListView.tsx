import { useCallback, useMemo, useRef } from "react";
import { View, Text, TouchableOpacity, ScrollView, RefreshControl, StyleSheet } from "react-native";
import type { RemoteJob, JobStatus } from "../types/job";
import type { ClaudeProcess } from "../types/process";
import { JobCard } from "./JobCard";
import { RunningJobCard } from "./RunningJobCard";
import { ProcessCard } from "./ProcessCard";
import { AgentSection } from "./AgentSection";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

const IDLE_STATUS: JobStatus = { state: "idle" };

export interface JobListViewProps {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: ClaudeProcess[];
  collapsedGroups: Set<string>;
  onToggleGroup: (group: string) => void;
  groupOrder?: string[];
  onRefresh?: () => void;
  // Navigation
  onSelectJob?: (job: RemoteJob) => void;
  onSelectProcess?: (process: ClaudeProcess) => void;
  // Agent
  onRunAgent?: (prompt: string) => void;
  // Desktop-only slots
  onAddJob?: (group: string) => void;
  onEditJob?: (job: RemoteJob) => void;
  onOpenJob?: (job: RemoteJob) => void;
  // Header content (for banners, notifications, etc.)
  headerContent?: React.ReactNode;
  // Show empty state
  showEmpty?: boolean;
  emptyMessage?: string;
}

type ListItem =
  | { kind: "agent" }
  | { kind: "header"; group: string; displayGroup: string }
  | { kind: "job"; job: RemoteJob; idx: number }
  | { kind: "process"; process: ClaudeProcess };

export function JobListView({
  jobs,
  statuses,
  detectedProcesses,
  collapsedGroups,
  onToggleGroup,
  groupOrder: _groupOrder = [],
  onRefresh,
  onSelectJob,
  onSelectProcess,
  onRunAgent,
  headerContent,
  showEmpty = true,
  emptyMessage = "No jobs found.",
}: JobListViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, RemoteJob[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(job);
    }
    return map;
  }, [jobs]);

  const matchedProcessesByGroup = useMemo(() => {
    const map = new Map<string, ClaudeProcess[]>();
    for (const proc of detectedProcesses) {
      if (proc.matched_group) {
        const list = map.get(proc.matched_group) ?? [];
        list.push(proc);
        map.set(proc.matched_group, list);
      }
    }
    return map;
  }, [detectedProcesses]);

  const unmatchedProcesses = useMemo(
    () => detectedProcesses.filter((p) => !p.matched_group),
    [detectedProcesses],
  );

  const items = useMemo(() => {
    const result: ListItem[] = [];

    // Agent section
    if (onRunAgent) {
      result.push({ kind: "agent" });
    }

    const hasMultipleGroups = grouped.size > 1 || unmatchedProcesses.length > 0;

    for (const [group, groupJobs] of grouped) {
      const displayGroup = group === "default" ? "General" : group;
      if (hasMultipleGroups || result.length > 1) {
        result.push({ kind: "header", group: displayGroup, displayGroup });
      }
      if (!collapsedGroups.has(displayGroup)) {
        let jobIdx = 0;
        for (const job of groupJobs) {
          result.push({ kind: "job", job, idx: jobIdx++ });
        }
        for (const proc of matchedProcessesByGroup.get(group) ?? []) {
          result.push({ kind: "process", process: proc });
        }
      }
    }

    if (unmatchedProcesses.length > 0) {
      // Group unmatched processes by CWD: folders with 2+ get their own group
      const byFolder = new Map<string, ClaudeProcess[]>();
      for (const proc of unmatchedProcesses) {
        const list = byFolder.get(proc.cwd) ?? [];
        list.push(proc);
        byFolder.set(proc.cwd, list);
      }
      const folderGroups: [string, ClaudeProcess[]][] = [];
      const ungrouped: ClaudeProcess[] = [];
      for (const [folder, procs] of byFolder) {
        if (procs.length >= 2 && folder) {
          folderGroups.push([folder, procs]);
        } else {
          ungrouped.push(...procs);
        }
      }
      for (const [folder, procs] of folderGroups) {
        const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
        const groupKey = `_det_${folder}`;
        result.push({ kind: "header", group: groupKey, displayGroup: folderName });
        if (!collapsedGroups.has(groupKey)) {
          for (const proc of procs) {
            result.push({ kind: "process", process: proc });
          }
        }
      }
      if (ungrouped.length > 0) {
        result.push({ kind: "header", group: "Detected", displayGroup: "Detected" });
        if (!collapsedGroups.has("Detected")) {
          for (const proc of ungrouped) {
            result.push({ kind: "process", process: proc });
          }
        }
      }
    }

    return result;
  }, [grouped, collapsedGroups, matchedProcessesByGroup, unmatchedProcesses, onRunAgent]);

  const agentProcess = useMemo(
    () => detectedProcesses.find((p) => p.cwd.endsWith("/clawtab/agent")) ?? null,
    [detectedProcesses],
  );

  const agentStatus: JobStatus = statuses["agent"] ?? (agentProcess ? { state: "running", run_id: "", started_at: "" } : IDLE_STATUS);

  const handleRefresh = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.list}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={false}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        ) : undefined
      }
    >
      {headerContent}
      {items.length === 0 && showEmpty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No jobs</Text>
          <Text style={styles.emptyText}>{emptyMessage}</Text>
        </View>
      ) : (
        items.map((item, index) => {
          const key =
            item.kind === "agent"
              ? "agent"
              : item.kind === "header"
                ? `h_${item.group}`
                : item.kind === "process"
                  ? `p_${item.process.pane_id}`
                  : `j_${item.job.name}`;

          if (item.kind === "agent") {
            return (
              <View key={key} style={{ marginBottom: spacing.md }}>
                <AgentSection
                  agentStatus={agentStatus}
                  agentProcess={agentProcess}
                  collapsed={collapsedGroups.has("Agent")}
                  onToggleCollapse={() => onToggleGroup("Agent")}
                  onRunAgent={onRunAgent!}
                  onSelectProcess={onSelectProcess ? () => onSelectProcess(agentProcess!) : undefined}
                />
              </View>
            );
          }

          if (item.kind === "header") {
            const isCollapsed = collapsedGroups.has(item.group);
            return (
              <View key={key} style={index > 0 ? { marginTop: spacing.sm } : undefined}>
                <TouchableOpacity
                  onPress={() => onToggleGroup(item.group)}
                  style={styles.groupHeaderRow}
                  activeOpacity={0.6}
                >
                  <Text style={styles.groupHeaderArrow}>
                    {isCollapsed ? "\u25B6" : "\u25BC"}
                  </Text>
                  <Text style={styles.groupHeader}>{item.displayGroup}</Text>
                </TouchableOpacity>
              </View>
            );
          }

          if (item.kind === "process") {
            return (
              <View key={key} style={index > 0 ? { marginTop: spacing.sm } : undefined}>
                <ProcessCard
                  process={item.process}
                  onPress={onSelectProcess ? () => onSelectProcess(item.process) : undefined}
                />
              </View>
            );
          }

          // job
          const status = statuses[item.job.name] ?? IDLE_STATUS;
          return (
            <View
              key={key}
              style={[
                item.idx % 2 === 1 ? { opacity: 0.85 } : undefined,
                index > 0 ? { marginTop: spacing.sm } : undefined,
              ]}
            >
              {status.state === "running" ? (
                <RunningJobCard
                  jobName={item.job.name}
                  onPress={onSelectJob ? () => onSelectJob(item.job) : undefined}
                />
              ) : (
                <JobCard
                  job={item.job}
                  status={status}
                  onPress={onSelectJob ? () => onSelectJob(item.job) : undefined}
                />
              )}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  list: {
    padding: spacing.lg,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  emptyText: { color: colors.textSecondary, fontSize: 14 },
  groupHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  groupHeaderArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
