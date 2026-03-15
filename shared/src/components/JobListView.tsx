import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, RefreshControl, StyleSheet, Platform, type StyleProp, type ViewStyle } from "react-native";
import type { RemoteJob, JobStatus, JobSortMode } from "../types/job";
import type { ClaudeProcess } from "../types/process";
import { JobCard } from "./JobCard";
import { RunningJobCard } from "./RunningJobCard";
import { ProcessCard } from "./ProcessCard";
import { GroupAgentRow } from "./GroupAgentRow";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

const IDLE_STATUS: JobStatus = { state: "idle" };

const SORT_OPTIONS: { value: JobSortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent" },
  { value: "added", label: "Added" },
];

function getStatusTimestamp(status: JobStatus | undefined): string | null {
  if (!status) return null;
  if (status.state === "running") return status.started_at;
  if (status.state === "success") return status.last_run;
  if (status.state === "failed") return status.last_run;
  return null;
}

function sortGroupKeys(
  keys: string[],
  grouped: Map<string, RemoteJob[]>,
  mode: JobSortMode,
  statuses: Record<string, JobStatus>,
): string[] {
  const sorted = [...keys];
  if (mode === "name") {
    sorted.sort((a, b) => {
      const da = a === "default" ? "General" : a;
      const db = b === "default" ? "General" : b;
      return da.localeCompare(db);
    });
  } else if (mode === "recent") {
    sorted.sort((a, b) => {
      const bestA = bestTimestamp(grouped.get(a) ?? [], statuses);
      const bestB = bestTimestamp(grouped.get(b) ?? [], statuses);
      if (bestA && bestB) return bestB.localeCompare(bestA);
      if (bestA) return -1;
      if (bestB) return 1;
      return a.localeCompare(b);
    });
  } else if (mode === "added") {
    sorted.sort((a, b) => {
      const bestA = newestAdded(grouped.get(a) ?? []);
      const bestB = newestAdded(grouped.get(b) ?? []);
      if (bestA && bestB) return bestB.localeCompare(bestA);
      if (bestA) return -1;
      if (bestB) return 1;
      return a.localeCompare(b);
    });
  }
  return sorted;
}

function bestTimestamp(jobs: RemoteJob[], statuses: Record<string, JobStatus>): string | null {
  let best: string | null = null;
  for (const job of jobs) {
    const ts = getStatusTimestamp(statuses[job.slug]);
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

function newestAdded(jobs: RemoteJob[]): string | null {
  let best: string | null = null;
  for (const job of jobs) {
    const ts = job.added_at;
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

export interface JobListViewProps {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: ClaudeProcess[];
  collapsedGroups: Set<string>;
  onToggleGroup: (group: string) => void;
  groupOrder?: string[];
  onRefresh?: () => void;
  // Sorting
  sortMode?: JobSortMode;
  onSortChange?: (mode: JobSortMode) => void;
  // Navigation
  onSelectJob?: (job: RemoteJob) => void;
  onSelectProcess?: (process: ClaudeProcess) => void;
  // Agent
  onRunAgent?: (prompt: string, workDir?: string) => void;
  // Desktop-only slots
  onAddJob?: (group: string, folderPath?: string) => void;
  onEditJob?: (job: RemoteJob) => void;
  onOpenJob?: (job: RemoteJob) => void;
  // Header content (for banners, notifications, etc.)
  headerContent?: React.ReactNode;
  // Show empty state
  showEmpty?: boolean;
  emptyMessage?: string;
  // Extra style for scroll content container
  contentContainerStyle?: StyleProp<ViewStyle>;
}

type ListItem =
  | { kind: "header"; group: string; displayGroup: string; folderPath?: string }
  | { kind: "job"; job: RemoteJob; idx: number }
  | { kind: "process"; process: ClaudeProcess }
  | { kind: "group-agent"; workDir: string };

export function JobListView({
  jobs,
  statuses,
  detectedProcesses,
  collapsedGroups,
  onToggleGroup,
  groupOrder: _groupOrder = [],
  onRefresh,
  sortMode = "name",
  onSortChange,
  onSelectJob,
  onSelectProcess,
  onRunAgent,
  onAddJob,
  headerContent,
  showEmpty = true,
  emptyMessage = "No jobs found.",
  contentContainerStyle,
}: JobListViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const searchRef = useRef<TextInput>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Keyboard shortcut: Cmd+F (desktop) or / (web) to focus search
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "/") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const query = searchQuery.toLowerCase().trim();

  const grouped = useMemo(() => {
    const map = new Map<string, RemoteJob[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      const displayGroup = group === "default" ? "general" : group.toLowerCase();
      if (query) {
        const nameMatch = job.name.toLowerCase().includes(query);
        const groupMatch = displayGroup.includes(query);
        if (!nameMatch && !groupMatch) continue;
      }
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [, groupJobs] of map) {
        groupJobs.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return map;
  }, [jobs, query, sortMode]);

  const sortedGroupKeys = useMemo(
    () => sortGroupKeys([...grouped.keys()], grouped, sortMode, statuses),
    [grouped, sortMode, statuses],
  );

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
    () => detectedProcesses.filter((p) => {
      if (p.matched_group) return false;
      if (!query) return true;
      const folderName = p.cwd.split("/").filter(Boolean).pop() ?? "";
      return folderName.toLowerCase().includes(query) || p.cwd.toLowerCase().includes(query);
    }),
    [detectedProcesses, query],
  );

  const items = useMemo(() => {
    const result: ListItem[] = [];

    // Build detected-process folder groups and ungrouped list
    const detFolderGroups: [string, ClaudeProcess[]][] = [];
    const detUngrouped: ClaudeProcess[] = [];
    if (unmatchedProcesses.length > 0) {
      const byFolder = new Map<string, ClaudeProcess[]>();
      for (const proc of unmatchedProcesses) {
        const list = byFolder.get(proc.cwd) ?? [];
        list.push(proc);
        byFolder.set(proc.cwd, list);
      }
      for (const [folder, procs] of byFolder) {
        if (procs.length >= 2 && folder) {
          detFolderGroups.push([folder, procs]);
        } else {
          detUngrouped.push(...procs);
        }
      }
    }

    // Unified group entries for interleaved sorting
    type GroupEntry =
      | { type: "job"; group: string; displayGroup: string; folderPath?: string; jobs: RemoteJob[]; procs: ClaudeProcess[] }
      | { type: "detected"; groupKey: string; displayGroup: string; folderPath: string; procs: ClaudeProcess[] }
      | { type: "ungrouped"; procs: ClaudeProcess[] };

    const allGroups: GroupEntry[] = [];

    for (const group of sortedGroupKeys) {
      const gJobs = grouped.get(group) ?? [];
      const displayGroup = group === "default" ? "General" : group;
      const fp = gJobs[0]?.folder_path ?? gJobs[0]?.work_dir;
      allGroups.push({
        type: "job",
        group,
        displayGroup,
        folderPath: fp,
        jobs: gJobs,
        procs: matchedProcessesByGroup.get(group) ?? [],
      });
    }

    for (const [folder, procs] of detFolderGroups) {
      const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
      allGroups.push({
        type: "detected",
        groupKey: `_det_${folder}`,
        displayGroup: folderName,
        folderPath: folder,
        procs,
      });
    }

    // When sorting by name, interleave all groups alphabetically
    if (sortMode === "name") {
      allGroups.sort((a, b) => {
        const da = a.displayGroup === "General" ? "General" : a.displayGroup;
        const db = b.displayGroup === "General" ? "General" : b.displayGroup;
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }

    if (detUngrouped.length > 0) {
      allGroups.push({ type: "ungrouped", procs: detUngrouped });
    }

    const hasMultipleGroups = allGroups.length > 1;

    for (const entry of allGroups) {
      if (entry.type === "job") {
        if (hasMultipleGroups || result.length > 0) {
          result.push({ kind: "header", group: entry.displayGroup, displayGroup: entry.displayGroup, folderPath: entry.folderPath });
        }
        if (!collapsedGroups.has(entry.displayGroup)) {
          let jobIdx = 0;
          for (const job of entry.jobs) {
            result.push({ kind: "job", job, idx: jobIdx++ });
          }
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc });
          }
          if (onRunAgent) {
            const groupWorkDir = entry.jobs[0]?.folder_path ?? entry.jobs[0]?.work_dir;
            if (groupWorkDir) {
              result.push({ kind: "group-agent", workDir: groupWorkDir });
            }
          }
        }
      } else if (entry.type === "detected") {
        result.push({ kind: "header", group: entry.groupKey, displayGroup: entry.displayGroup, folderPath: entry.folderPath });
        if (!collapsedGroups.has(entry.groupKey)) {
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc });
          }
          if (onRunAgent && entry.folderPath) {
            result.push({ kind: "group-agent", workDir: entry.folderPath });
          }
        }
      } else {
        result.push({ kind: "header", group: "Detected", displayGroup: "Detected" });
        if (!collapsedGroups.has("Detected")) {
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc });
          }
        }
      }
    }

    return result;
  }, [grouped, sortedGroupKeys, collapsedGroups, matchedProcessesByGroup, unmatchedProcesses, onRunAgent]);

  const handleRefresh = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);

  const renderItems = () => {
    if (items.length === 0 && (showEmpty || query)) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{query ? "No matches" : "No jobs"}</Text>
          <Text style={styles.emptyText}>{query ? `No jobs or groups matching "${searchQuery}"` : emptyMessage}</Text>
        </View>
      );
    }
    return items.map((item, index) => {
      const key =
        item.kind === "header"
          ? `h_${item.group}`
          : item.kind === "process"
            ? `p_${item.process.pane_id}`
            : item.kind === "group-agent"
              ? `ga_${item.workDir}`
              : `j_${item.job.slug || item.job.name}`;

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
              {onAddJob && (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation(); onAddJob(item.group, item.folderPath); }}
                  style={styles.addJobBtn}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.addJobBtnText}>+</Text>
                </TouchableOpacity>
              )}
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

      if (item.kind === "group-agent") {
        return (
          <View key={key} style={{ marginTop: spacing.sm }}>
            <GroupAgentRow
              onRunAgent={(prompt) => onRunAgent!(prompt, item.workDir)}
            />
          </View>
        );
      }

      // job
      const status = statuses[item.job.slug] ?? IDLE_STATUS;
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
    });
  };

  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Name";

  const handleSelectSort = useCallback((mode: JobSortMode) => {
    onSortChange?.(mode);
    setSortOpen(false);
  }, [onSortChange]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    (document.activeElement as HTMLElement)?.blur();
  }, []);

  const toolbar = (onSortChange && jobs.length > 1) || jobs.length > 0 ? (
    <View style={styles.sortRow}>
      <View style={styles.searchBar}>
        <Text style={styles.searchIcon}>{"\u2315"}</Text>
        <TextInput
          ref={searchRef}
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Filter jobs..."
          placeholderTextColor={colors.textMuted}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Escape") {
              handleClearSearch();
            }
          }}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={handleClearSearch} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.searchClear}>x</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={{ flex: 1 }} />
      {onSortChange && jobs.length > 1 && (
        <View>
          <TouchableOpacity
            onPress={() => setSortOpen(!sortOpen)}
            style={styles.sortTrigger}
            activeOpacity={0.6}
          >
            <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
            <Text style={styles.sortTriggerArrow}>{sortOpen ? "\u25B4" : "\u25BE"}</Text>
          </TouchableOpacity>
          {sortOpen && (
            <View style={styles.dropdownMenu}>
              {SORT_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => handleSelectSort(opt.value)}
                  style={[styles.dropdownItem, sortMode === opt.value && styles.dropdownItemActive]}
                  activeOpacity={0.6}
                >
                  <Text style={[
                    styles.dropdownItemText,
                    sortMode === opt.value && styles.dropdownItemTextActive,
                  ]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  ) : null;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.list, contentContainerStyle]}
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
      {toolbar}
      {renderItems()}
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
  addJobBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  addJobBtnText: {
    color: colors.textSecondary,
    fontSize: 18,
    fontWeight: "300",
    lineHeight: 20,
  },
  groupHeaderArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  searchIcon: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    maxWidth: 240,
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 4,
    outlineStyle: "none",
  } as any,
  searchClear: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
    paddingHorizontal: 4,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xs,
    zIndex: 10,
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  sortTriggerText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  sortTriggerArrow: {
    color: colors.textSecondary,
    fontSize: 10,
  },
  dropdownMenu: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    minWidth: 120,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 10,
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  dropdownItemActive: {
    backgroundColor: colors.accentBg,
  },
  dropdownItemText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  dropdownItemTextActive: {
    color: colors.accent,
    fontWeight: "500",
  },
});
