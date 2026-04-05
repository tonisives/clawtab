import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, RefreshControl, StyleSheet, Platform, type StyleProp, type ViewStyle } from "react-native";

const isWeb = Platform.OS === "web";
import type { RemoteJob, JobStatus, JobSortMode } from "../types/job";
import type { ClaudeProcess } from "../types/process";
import { PopupMenu } from "./PopupMenu";
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
  // Map of slug/pane_id -> color hex for highlighted items (supports multi-selection)
  selectedItems?: Map<string, string> | null;
  // Single selection (backward compat with desktop) - uses accent color
  selectedSlug?: string | null;
  // Agent
  onRunAgent?: (prompt: string, workDir?: string) => void;
  // Desktop-only slots
  onAddJob?: (group: string, folderPath?: string) => void;
  onEditJob?: (job: RemoteJob) => void;
  onOpenJob?: (job: RemoteJob) => void;
  // Hidden groups
  hiddenGroups?: Set<string>;
  onHideGroup?: (group: string) => void;
  onUnhideGroup?: (group: string) => void;
  // Header content (for banners, notifications, etc.)
  headerContent?: React.ReactNode;
  // Show empty state
  showEmpty?: boolean;
  emptyMessage?: string;
  // Extra style for scroll content container
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Restore scroll position (web only)
  initialScrollOffset?: number;
  // Report scroll position changes (web only)
  onScrollOffsetChange?: (offset: number) => void;
  // Scroll a specific slug into view (bumped counter to trigger re-scroll)
  scrollToSlug?: string | null;
  // Custom card renderers (for drag-and-drop wrappers)
  renderJobCard?: (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: boolean | string }) => React.ReactNode;
  renderProcessCard?: (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: boolean | string }) => React.ReactNode;
  // Disable scrolling (e.g. during drag-and-drop)
  scrollEnabled?: boolean;
}

type ListItem =
  | { kind: "header"; group: string; displayGroup: string; folderPath?: string }
  | { kind: "job"; job: RemoteJob; idx: number }
  | { kind: "process"; process: ClaudeProcess; inGroup?: boolean }
  | { kind: "group-agent"; workDir: string }
  | { kind: "hidden-section" }
  | { kind: "hidden-header"; group: string; displayGroup: string };

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
  selectedItems,
  selectedSlug,
  onRunAgent,
  onAddJob,
  hiddenGroups,
  onHideGroup,
  onUnhideGroup,
  headerContent,
  showEmpty = true,
  emptyMessage = "No jobs found.",
  contentContainerStyle,
  initialScrollOffset,
  onScrollOffsetChange,
  scrollToSlug,
  renderJobCard: customRenderJobCard,
  renderProcessCard: customRenderProcessCard,
  scrollEnabled = true,
}: JobListViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const searchRef = useRef<TextInput>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupMenu, setGroupMenu] = useState<{ group: string; folderPath?: string } | null>(null);
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null);
  const groupMenuDropdownRef = useRef<View>(null);
  const groupMenuTriggerRef = useRef<any>(null);
  const sortTriggerRef = useRef<any>(null);

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

  // (outside-click for group menu handled by PopupMenu)

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
      const fp = gJobs[0]?.folder_path ?? gJobs[0]?.work_dir;
      const displayGroup = group === "default"
        ? (fp ? fp.split("/").filter(Boolean).pop() ?? "General" : "General")
        : group;
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
      // Merge into existing job group if one shares this folder path
      const existing = allGroups.find(
        (g) => g.type === "job" && g.folderPath === folder,
      );
      if (existing && existing.type === "job") {
        existing.procs = [...existing.procs, ...procs];
      } else {
        const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
        allGroups.push({
          type: "detected",
          groupKey: `_det_${folder}`,
          displayGroup: folderName,
          folderPath: folder,
          procs,
        });
      }
    }

    // When sorting by name, interleave all groups alphabetically
    if (sortMode === "name") {
      allGroups.sort((a, b) => {
        const da = "displayGroup" in a ? a.displayGroup : "";
        const db = "displayGroup" in b ? b.displayGroup : "";
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }

    if (detUngrouped.length > 0) {
      allGroups.push({ type: "ungrouped", procs: detUngrouped });
    }

    // Split into visible and hidden groups
    const isGroupHidden = (entry: GroupEntry) => {
      if (!hiddenGroups?.size) return false;
      const name = "displayGroup" in entry ? entry.displayGroup : "";
      return hiddenGroups.has(name);
    };

    const visibleGroups = allGroups.filter((e) => !isGroupHidden(e));
    const hiddenEntries = allGroups.filter((e) => isGroupHidden(e));
    const hasMultipleGroups = visibleGroups.length > 1;

    for (const entry of visibleGroups) {
      if (entry.type === "job") {
        if (hasMultipleGroups || result.length > 0 || query) {
          result.push({ kind: "header", group: entry.displayGroup, displayGroup: entry.displayGroup, folderPath: entry.folderPath });
        }
        if (!collapsedGroups.has(entry.displayGroup)) {
          let jobIdx = 0;
          for (const job of entry.jobs) {
            result.push({ kind: "job", job, idx: jobIdx++ });
          }
          for (const proc of entry.procs) {
            result.push({ kind: "process", process: proc, inGroup: true });
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

    // Add hidden groups section at the bottom
    if (hiddenEntries.length > 0) {
      result.push({ kind: "hidden-section" });
      for (const entry of hiddenEntries) {
        const displayGroup = "displayGroup" in entry ? entry.displayGroup : "Detected";
        const group = entry.type === "job" ? entry.displayGroup : entry.type === "detected" ? entry.groupKey : "Detected";
        result.push({ kind: "hidden-header", group, displayGroup });
      }
    }

    return result;
  }, [grouped, sortedGroupKeys, collapsedGroups, hiddenGroups, matchedProcessesByGroup, unmatchedProcesses, onRunAgent]);

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
              : item.kind === "hidden-section"
                ? "hidden_section"
                : item.kind === "hidden-header"
                  ? `hh_${item.group}`
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
              {item.folderPath && (
                <Text style={styles.groupFolderPath} numberOfLines={1}>
                  {item.folderPath.replace(/^\/Users\/[^/]+/, "~")}
                </Text>
              )}
              {(onAddJob || onHideGroup) && (
                <TouchableOpacity
                  ref={(r: any) => { if (groupMenu?.group === item.group) groupMenuTriggerRef.current = r; }}
                  onPress={(e: any) => {
                    e.stopPropagation();
                    if (groupMenu?.group === item.group) {
                      setGroupMenu(null);
                      return;
                    }
                    if (isWeb) {
                      const node = e?.currentTarget ?? e?.target;
                      groupMenuTriggerRef.current = node;
                      if (node?.getBoundingClientRect) {
                        const rect = node.getBoundingClientRect();
                        setGroupMenuPos({ top: rect.bottom + 4, left: rect.right });
                      }
                    }
                    setGroupMenu({ group: item.group, folderPath: item.folderPath });
                  }}
                  style={styles.addJobBtn}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.addJobBtnText}>{"\u2026"}</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          </View>
        );
      }

      if (item.kind === "process") {
        const pressHandler = onSelectProcess ? () => onSelectProcess(item.process) : undefined;
        const isSelected = selectedItems?.get(item.process.pane_id) ?? (selectedSlug === item.process.pane_id);
        return (
          <View key={key} {...(Platform.OS === "web" ? { dataSet: { processId: item.process.pane_id } } : {})} style={index > 0 ? { marginTop: spacing.sm } : undefined}>
            {customRenderProcessCard
              ? customRenderProcessCard({ process: item.process, onPress: pressHandler, inGroup: item.inGroup, selected: isSelected })
              : <ProcessCard process={item.process} onPress={pressHandler} inGroup={item.inGroup} selected={isSelected} />
            }
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

      if (item.kind === "hidden-section") {
        return (
          <View key={key} style={{ marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm }}>
            <Text style={[styles.groupHeader, { fontSize: 10, color: colors.textMuted }]}>Hidden Groups</Text>
          </View>
        );
      }

      if (item.kind === "hidden-header") {
        return (
          <View key={key} style={{ marginTop: spacing.xs }}>
            <View style={[styles.groupHeaderRow, { opacity: 0.5 }]}>
              <Text style={styles.groupHeader}>{item.displayGroup}</Text>
              <View style={{ flex: 1 }} />
              {onUnhideGroup && (
                <TouchableOpacity
                  onPress={() => onUnhideGroup(item.group)}
                  style={styles.addJobBtn}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>Show</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      }

      // job
      const status = statuses[item.job.slug] ?? IDLE_STATUS;
      const pressHandler = onSelectJob ? () => onSelectJob(item.job) : undefined;
      const isSelected = selectedItems?.get(item.job.slug) ?? (selectedSlug === item.job.slug);
      return (
        <View
          key={key}
          {...(Platform.OS === "web" ? { dataSet: { jobSlug: item.job.slug } } : {})}
          style={[
            item.idx % 2 === 1 ? { opacity: 0.85 } : undefined,
            index > 0 ? { marginTop: spacing.sm } : undefined,
          ]}
        >
          {customRenderJobCard
            ? customRenderJobCard({ job: item.job, status, onPress: pressHandler, selected: isSelected })
            : status.state === "running" ? (
              <RunningJobCard
                jobName={item.job.name}
                status={status}
                onPress={pressHandler}
                selected={isSelected}
              />
            ) : (
              <JobCard
                job={item.job}
                status={status}
                onPress={pressHandler}
                selected={isSelected}
              />
            )
          }
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
          returnKeyType="done"
          inputAccessoryViewID={Platform.OS === "ios" ? "keyboard-dismiss" : undefined}
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
            ref={sortTriggerRef}
            onPress={() => setSortOpen(!sortOpen)}
            style={styles.sortTrigger}
            activeOpacity={0.6}
          >
            <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
            <Text style={styles.sortTriggerArrow}>{sortOpen ? "\u25B4" : "\u25BE"}</Text>
          </TouchableOpacity>
          {sortOpen && (
            <PopupMenu
              items={SORT_OPTIONS.map((opt) => ({
                type: "item" as const,
                label: opt.label,
                onPress: () => handleSelectSort(opt.value),
                active: sortMode === opt.value,
              }))}
              triggerRef={sortTriggerRef}
              onClose={() => setSortOpen(false)}
            />
          )}
        </View>
      )}
    </View>
  ) : null;

  // Scroll a specific job into view when scrollToSlug changes
  const prevScrollSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollToSlug || Platform.OS !== "web") return;
    if (scrollToSlug === prevScrollSlug.current) return;
    prevScrollSlug.current = scrollToSlug;
    const escaped = CSS.escape(scrollToSlug);
    const el = (
      document.querySelector(`[data-job-slug="${escaped}"]`) ??
      document.querySelector(`[data-process-id="${escaped}"]`)
    ) as HTMLElement | null;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [scrollToSlug]);

  // Restore scroll position on mount
  useEffect(() => {
    if (!initialScrollOffset) return;
    // Double rAF to wait for layout, plus a fallback timeout
    const restore = () => scrollRef.current?.scrollTo({ y: initialScrollOffset, animated: false });
    requestAnimationFrame(() => requestAnimationFrame(restore));
    const t = setTimeout(restore, 100);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On macOS WebKit, elastic bounce won't re-trigger when scroll is pinned at
  // the exact boundary (0 or scrollHeight). Keep 1px of scroll room so the
  // rubber-band effect can fire repeatedly.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (scrollRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (node.scrollTop <= 0) {
          node.scrollTop = 1;
        } else if (node.scrollTop + node.clientHeight >= node.scrollHeight) {
          node.scrollTop = node.scrollHeight - node.clientHeight - 1;
        }
      }, 150);
    };
    // Set initial 1px offset so first top-bounce works after content loads
    requestAnimationFrame(() => { if (node.scrollTop === 0 && node.scrollHeight > node.clientHeight) node.scrollTop = 1; });
    node.addEventListener("scroll", nudge, { passive: true });
    return () => { node.removeEventListener("scroll", nudge); if (timer) clearTimeout(timer); };
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.list, contentContainerStyle]}
      scrollEnabled={scrollEnabled}
      automaticallyAdjustKeyboardInsets
      onScroll={(e) => { onScrollOffsetChange?.(e.nativeEvent.contentOffset.y); }}
      scrollEventThrottle={100}
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
      {groupMenu && (onAddJob || onHideGroup) && (
        <PopupMenu
          items={[
            ...(onAddJob ? [{ type: "item" as const, label: "Add Job", onPress: () => onAddJob(groupMenu.group, groupMenu.folderPath) }] : []),
            ...(onHideGroup ? [{ type: "item" as const, label: "Hide Group", onPress: () => onHideGroup(groupMenu.group) }] : []),
          ]}
          position={groupMenuPos}
          dropdownRef={groupMenuDropdownRef}
          triggerRef={groupMenuTriggerRef}
          onClose={() => setGroupMenu(null)}
        />
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
    fontWeight: "700",
    lineHeight: 20,
    letterSpacing: 1,
  },
  groupHeaderArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  groupFolderPath: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
    minWidth: 0,
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
});
