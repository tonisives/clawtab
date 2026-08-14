import { useMemo } from "react";

import type { RemoteJob, JobStatus, JobSortMode, LatestSortMode } from "../../types/job";
import type { DetectedProcess, ProcessProvider, ShellPane } from "../../types/process";
import { processDisplayTitle } from "../../util/format";
import type { ListItem } from "./sign";
import {
  displayGroupName,
  inferProcessJobSlug,
  matchesProcessQuery,
  matchesQuery,
  matchesShellQuery,
  sortGroupKeys,
} from "./helpers";

const processActivityTimestamp = (process: DetectedProcess): number => (
  process._last_activity
  ?? process._last_log_change
  ?? (process.session_started_at ? Date.parse(process.session_started_at) || 0 : 0)
);

const jobActivityTimestamp = (status: JobStatus | undefined): number => {
  if (status?.state === "running") return Date.parse(status.started_at) || 0;
  if (status?.state === "success" || status?.state === "failed") {
    return Date.parse(status.last_run) || 0;
  }
  return 0;
};

const processStartedTimestamp = (process: DetectedProcess): number => (
  process.session_started_at ? Date.parse(process.session_started_at) || 0 : 0
);

const PINNED_GROUP_KEY = "__pinned";

const processLatestTimestamp = (process: DetectedProcess, sortMode: LatestSortMode): number => {
  if (sortMode === "message") return process._last_user_message ?? processStartedTimestamp(process);
  if (sortMode === "activity") return process._last_activity ?? processStartedTimestamp(process);
  return processStartedTimestamp(process);
};

const jobAddedTimestamp = (job: RemoteJob): number => (
  job.added_at ? Date.parse(job.added_at) || 0 : 0
);

const processSortTimestamp = (process: DetectedProcess, sortMode: JobSortMode): number => (
  sortMode === "activity" ? processActivityTimestamp(process) : processStartedTimestamp(process)
);

const jobSortTimestamp = (job: RemoteJob, status: JobStatus | undefined, sortMode: JobSortMode): number => (
  sortMode === "added" ? jobAddedTimestamp(job) : jobActivityTimestamp(status)
);

const compareProcessActivity = (left: DetectedProcess, right: DetectedProcess): number => (
  processActivityTimestamp(right) - processActivityTimestamp(left)
  || (left.display_name ?? left.first_query ?? left.cwd).localeCompare(
    right.display_name ?? right.first_query ?? right.cwd,
  )
);

function getPinnedRows(
  pinnedItems: string[] | undefined,
  jobs: RemoteJob[],
  detectedProcesses: DetectedProcess[],
): ListItem[] {
  if (!pinnedItems?.length) return [];

  const pinnedRows: ListItem[] = [];
  const jobsBySlug = new Map(jobs.map((job) => [job.slug, job]));
  const processesByPaneId = new Map(detectedProcesses.map((process) => [process.pane_id, process]));
  for (const key of pinnedItems) {
    const [kind, id] = key.split(/:(.*)/s);
    if (kind === "job") {
      const job = jobsBySlug.get(id);
      if (job) pinnedRows.push({ kind: "job", job, idx: 0 });
    } else if (kind === "process") {
      const process = processesByPaneId.get(id);
      if (process) pinnedRows.push({ kind: "process", process });
    }
  }
  return pinnedRows;
}

interface UseJobListDerivedItemsParams {
  data: {
    detectedProcesses: DetectedProcess[];
    jobs: RemoteJob[];
    shellPanes: ShellPane[];
    statuses: Record<string, JobStatus>;
  };
  ordering: {
    groupLatestSortMode?: Record<string, LatestSortMode>;
    jobOrder: Record<string, string[]>;
    latestSortMode?: LatestSortMode;
    processOrder: Record<string, string[]>;
    sortMode: JobSortMode;
  };
  grouping: {
    collapsedGroups: Set<string>;
    groupTabView?: Record<string, "tabs" | "jobs">;
    hiddenGroups?: Set<string>;
    hiddenSectionCollapsed: boolean;
    interactiveHiddenGroups?: boolean;
    listMode: "tabs" | "latest" | "jobs";
    pinnedItems?: string[];
  };
  filters: {
    query: string;
  };
  agent: {
    onRunAgent?: (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) => void;
  };
}

export function useJobListDerivedItems({
  data,
  ordering,
  grouping,
  filters,
  agent,
}: UseJobListDerivedItemsParams) {
  const { detectedProcesses, jobs, shellPanes, statuses } = data;
  const { groupLatestSortMode, jobOrder, latestSortMode, processOrder, sortMode } = ordering;
  const { collapsedGroups, groupTabView, hiddenGroups, hiddenSectionCollapsed, interactiveHiddenGroups, listMode, pinnedItems } = grouping;
  const { query } = filters;
  const { onRunAgent } = agent;
  const inferredJobSlugByPaneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const proc of detectedProcesses) {
      const slug = inferProcessJobSlug(proc, jobs, statuses);
      if (slug) map.set(proc.pane_id, slug);
    }
    return map;
  }, [detectedProcesses, jobs, statuses]);

  const tabSearchMatches = useMemo(() => {
    const groups = new Set<string>();
    const jobSlugs = new Set<string>();
    if (!query) return { groups, jobSlugs };

    const knownJobSlugs = new Set(jobs.map((job) => job.slug));
    const paneToRunningJobSlug = new Map<string, string>();
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state === "running" && status.pane_id) {
        paneToRunningJobSlug.set(status.pane_id, job.slug);
      }
    }

    for (const proc of detectedProcesses) {
      if (!matchesProcessQuery(proc, query)) continue;
      const inferredJobSlug = inferredJobSlugByPaneId.get(proc.pane_id);
      if (inferredJobSlug) jobSlugs.add(inferredJobSlug);
      const matchedRunningJob = paneToRunningJobSlug.get(proc.pane_id);
      if (matchedRunningJob) jobSlugs.add(matchedRunningJob);
      if (proc.matched_job && knownJobSlugs.has(proc.matched_job)) jobSlugs.add(proc.matched_job);
      if (proc.matched_group) groups.add(proc.matched_group);
    }

    for (const shell of shellPanes) {
      if (shell.matched_group && matchesShellQuery(shell, query)) {
        groups.add(shell.matched_group);
      }
    }

    return { groups, jobSlugs };
  }, [detectedProcesses, inferredJobSlugByPaneId, jobs, query, shellPanes, statuses]);

  const grouped = useMemo(() => {
    const map = new Map<string, RemoteJob[]>();
    const jobsByGroup = new Map<string, RemoteJob[]>();
    const processesByJob = new Map<string, DetectedProcess[]>();
    for (const process of detectedProcesses) {
      const jobSlug = inferredJobSlugByPaneId.get(process.pane_id);
      if (!jobSlug) continue;
      const processes = processesByJob.get(jobSlug) ?? [];
      processes.push(process);
      processesByJob.set(jobSlug, processes);
    }
    const groupJobTimestamp = (job: RemoteJob, mode: LatestSortMode) => Math.max(
      jobActivityTimestamp(statuses[job.slug]),
      0,
      ...(processesByJob.get(job.slug) ?? []).map((process) => processLatestTimestamp(process, mode)),
    );
    for (const job of jobs) {
      const group = job.group || "default";
      const list = jobsByGroup.get(group) ?? [];
      list.push(job);
      jobsByGroup.set(group, list);
    }

    for (const job of jobs) {
      const group = job.group || "default";
      const displayGroup = displayGroupName(group, jobsByGroup.get(group) ?? [job]);
      if (query) {
        const nameMatch = matchesQuery([job.name, job.slug, job.path, job.work_dir, job.folder_path], query);
        const groupMatch = matchesQuery([displayGroup, group === "default" ? "general" : group], query);
        const tabMatch = tabSearchMatches.jobSlugs.has(job.slug) || tabSearchMatches.groups.has(group);
        if (!nameMatch && !groupMatch && !tabMatch) continue;
      }
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [group, groupJobs] of map) {
        const manualOrder = jobOrder[group] ?? [];
        const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
        groupJobs.sort((a, b) => {
          const aIndex = manualIndex.get(a.slug);
          const bIndex = manualIndex.get(b.slug);
          if (aIndex != null && bIndex != null) return aIndex - bIndex;
          if (aIndex != null) return -1;
          if (bIndex != null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    } else {
      for (const groupJobs of map.values()) {
        groupJobs.sort((left, right) => (
          jobSortTimestamp(right, statuses[right.slug], sortMode) - jobSortTimestamp(left, statuses[left.slug], sortMode)
          || left.name.localeCompare(right.name)
        ));
      }
    }
    for (const [group, groupJobs] of map) {
      const groupSortMode = groupLatestSortMode?.[group];
      if (!groupSortMode) continue;
      groupJobs.sort((left, right) => (
        groupJobTimestamp(right, groupSortMode) - groupJobTimestamp(left, groupSortMode)
        || left.name.localeCompare(right.name)
      ));
    }
    return map;
  }, [detectedProcesses, groupLatestSortMode, inferredJobSlugByPaneId, jobOrder, jobs, query, sortMode, statuses, tabSearchMatches]);

  const sortedGroupKeys = useMemo(
    () => sortGroupKeys([...grouped.keys()], grouped, sortMode, statuses),
    [grouped, sortMode, statuses],
  );

  const matchedProcessesByGroup = useMemo(() => {
    const map = new Map<string, DetectedProcess[]>();
    const paneToRunningJobSlug = new Map<string, string>();
    const jobSlugs = new Set(jobs.map((job) => job.slug));
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state === "running" && status.pane_id) {
        paneToRunningJobSlug.set(status.pane_id, job.slug);
      }
    }
    for (const proc of detectedProcesses) {
      if (paneToRunningJobSlug.has(proc.pane_id)) continue;
      const inferredJobSlug = inferredJobSlugByPaneId.get(proc.pane_id);
      if (inferredJobSlug) continue;
      if (proc.matched_job && jobSlugs.has(proc.matched_job)) continue;
      if (proc.matched_group) {
        if (query) {
          const groupJobs = jobs.filter((job) => (job.group || "default") === proc.matched_group);
          const groupName = displayGroupName(proc.matched_group, groupJobs);
          const groupMatch = matchesQuery([groupName, proc.matched_group], query);
          if (!groupMatch && !matchesProcessQuery(proc, query)) continue;
        }
        const list = map.get(proc.matched_group) ?? [];
        list.push(proc);
        map.set(proc.matched_group, list);
      }
    }
    for (const [group, list] of map) {
      const groupSortMode = groupLatestSortMode?.[group];
      if (groupSortMode) {
        list.sort((left, right) => (
          processLatestTimestamp(right, groupSortMode) - processLatestTimestamp(left, groupSortMode)
          || compareProcessActivity(left, right)
        ));
        continue;
      }
      if (sortMode !== "name") {
        list.sort((left, right) => (
          processSortTimestamp(right, sortMode) - processSortTimestamp(left, sortMode)
          || compareProcessActivity(left, right)
        ));
        continue;
      }
      const manualOrder = processOrder[group] ?? [];
      const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
      list.sort((a, b) => {
        const aIndex = manualIndex.get(a.pane_id);
        const bIndex = manualIndex.get(b.pane_id);
        if (aIndex != null && bIndex != null) return aIndex - bIndex;
        if (aIndex != null) return -1;
        if (bIndex != null) return 1;
        return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
      });
    }
    return map;
  }, [detectedProcesses, groupLatestSortMode, inferredJobSlugByPaneId, jobs, processOrder, query, sortMode, statuses]);

  const matchedProcessesByJob = useMemo(() => {
    const map = new Map<string, DetectedProcess[]>();
    const paneToRunningJobSlug = new Map<string, string>();
    const jobSlugs = new Set(jobs.map((job) => job.slug));
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state === "running" && status.pane_id) {
        paneToRunningJobSlug.set(status.pane_id, job.slug);
      }
    }
    for (const proc of detectedProcesses) {
      const matchedJobSlug = inferredJobSlugByPaneId.get(proc.pane_id)
        ?? paneToRunningJobSlug.get(proc.pane_id)
        ?? (proc.matched_job && jobSlugs.has(proc.matched_job) ? proc.matched_job : null);
      if (!matchedJobSlug) continue;
      if (query) {
        const job = jobs.find((item) => item.slug === matchedJobSlug);
        const groupJobs = job ? jobs.filter((item) => (item.group || "default") === (job.group || "default")) : [];
        const groupName = job ? displayGroupName(job.group || "default", groupJobs) : null;
        const jobMatch = job ? matchesQuery([job.name, job.slug, job.path, job.work_dir, job.folder_path, groupName], query) : false;
        if (!jobMatch && !matchesProcessQuery(proc, query)) continue;
      }
      const list = map.get(matchedJobSlug) ?? [];
      list.push(proc);
      map.set(matchedJobSlug, list);
    }
    for (const [slug, list] of map) {
      const job = jobs.find((item) => item.slug === slug);
      const groupSortMode = job ? groupLatestSortMode?.[job.group || "default"] : undefined;
      if (groupSortMode) {
        list.sort((left, right) => (
          processLatestTimestamp(right, groupSortMode) - processLatestTimestamp(left, groupSortMode)
          || compareProcessActivity(left, right)
        ));
        continue;
      }
      if (sortMode !== "name") {
        list.sort((left, right) => (
          processSortTimestamp(right, sortMode) - processSortTimestamp(left, sortMode)
          || compareProcessActivity(left, right)
        ));
        continue;
      }
      const manualOrder = job ? processOrder[job.group || "default"] ?? [] : [];
      const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
      list.sort((a, b) => {
        const aIndex = manualIndex.get(a.pane_id);
        const bIndex = manualIndex.get(b.pane_id);
        if (aIndex != null && bIndex != null) return aIndex - bIndex;
        if (aIndex != null) return -1;
        if (bIndex != null) return 1;
        return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
      });
    }
    return map;
  }, [detectedProcesses, groupLatestSortMode, inferredJobSlugByPaneId, jobs, processOrder, query, sortMode, statuses]);

  const matchedShellsByGroup = useMemo(() => {
    const map = new Map<string, ShellPane[]>();
    for (const shell of shellPanes) {
      if (!shell.matched_group) continue;
      if (query) {
        const groupJobs = jobs.filter((job) => (job.group || "default") === shell.matched_group);
        const groupName = displayGroupName(shell.matched_group, groupJobs);
        const groupMatch = matchesQuery([groupName, shell.matched_group], query);
        if (!groupMatch && !matchesShellQuery(shell, query)) continue;
      }
      const list = map.get(shell.matched_group) ?? [];
      list.push(shell);
      map.set(shell.matched_group, list);
    }
    return map;
  }, [jobs, query, shellPanes]);

  const unmatchedProcesses = useMemo(
    () => {
      const jobSlugs = new Set(jobs.map((job) => job.slug));
      return detectedProcesses.filter((p) => {
        const matchedRunningJob = jobs.some((job) => {
          const status = statuses[job.slug];
          return status?.state === "running" && status.pane_id === p.pane_id;
        });
        if (matchedRunningJob) return false;
        if (inferredJobSlugByPaneId.has(p.pane_id)) return false;
        if (p.matched_job && jobSlugs.has(p.matched_job)) return false;
        if (p.matched_group) return false;
        if (!query) return true;
        const folderName = p.cwd.split("/").filter(Boolean).pop() ?? "";
        return matchesProcessQuery(p, query) || folderName.toLowerCase().includes(query) || p.cwd.toLowerCase().includes(query);
      });
    },
    [detectedProcesses, inferredJobSlugByPaneId, jobs, query, statuses],
  );

  const pinnedRows = useMemo(
    () => getPinnedRows(pinnedItems, jobs, detectedProcesses),
    [detectedProcesses, jobs, pinnedItems],
  );

  const latestItems = useMemo(() => {
    const rows: Array<{ item: ListItem; name: string; timestamp: number }> = [];

    for (const process of detectedProcesses) {
      const matchedJobSlug = inferredJobSlugByPaneId.get(process.pane_id);
      const matchedJob = matchedJobSlug
        ? jobs.find((job) => job.slug === matchedJobSlug)
        : null;
      const processMatches = !query || matchesProcessQuery(process, query);
      const jobMatches = !query || (matchedJob && matchesQuery([
        matchedJob.name,
        matchedJob.slug,
        matchedJob.path,
        matchedJob.work_dir,
        matchedJob.folder_path,
      ], query));
      if (!processMatches && !jobMatches) continue;
      rows.push({
        item: { kind: "process", process, inGroup: true },
        name: processDisplayTitle(process),
        timestamp: latestSortMode
          ? processLatestTimestamp(process, latestSortMode)
          : processSortTimestamp(process, sortMode),
      });
    }

    const processPaneIds = new Set(detectedProcesses.map((process) => process.pane_id));
    for (const job of jobs) {
      const status = statuses[job.slug];
      if (status?.state !== "running") continue;
      const hasProcess = (status.pane_id && processPaneIds.has(status.pane_id))
        || detectedProcesses.some((process) => inferredJobSlugByPaneId.get(process.pane_id) === job.slug);
      if (hasProcess) continue;
      if (query && !matchesQuery([job.name, job.slug, job.path, job.work_dir, job.folder_path], query)) {
        continue;
      }
      rows.push({
        item: { kind: "job", job, idx: 0 },
        name: job.name,
        timestamp: jobSortTimestamp(job, status, sortMode),
      });
    }

    rows.sort((left, right) => (
      !latestSortMode && sortMode === "name"
        ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
        : right.timestamp - left.timestamp
          || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    ));
    const result: ListItem[] = [];
    if (pinnedRows.length > 0) {
      result.push({ kind: "header", group: PINNED_GROUP_KEY, displayGroup: "Pinned" });
      if (query || !collapsedGroups.has(PINNED_GROUP_KEY)) {
        result.push(...pinnedRows);
      }
    }
    result.push(...rows.map((row) => row.item));
    return result;
  }, [collapsedGroups, detectedProcesses, inferredJobSlugByPaneId, jobs, latestSortMode, pinnedRows, query, sortMode, statuses]);

  const groupedItems = useMemo(() => {
    const result: ListItem[] = [];

    if (pinnedRows.length > 0) {
      result.push({ kind: "header", group: PINNED_GROUP_KEY, displayGroup: "Pinned" });
      if (query || !collapsedGroups.has(PINNED_GROUP_KEY)) {
        result.push(...pinnedRows);
      }
    }

    // Build detected-process folder groups and ungrouped list
    const detFolderGroups: [string, DetectedProcess[]][] = [];
    const detUngrouped: DetectedProcess[] = [];
    if (unmatchedProcesses.length > 0) {
      const orderedProcesses = sortMode !== "name"
        ? [...unmatchedProcesses].sort((left, right) => (
          processSortTimestamp(right, sortMode) - processSortTimestamp(left, sortMode)
          || compareProcessActivity(left, right)
        ))
        : unmatchedProcesses;
      const byFolder = new Map<string, DetectedProcess[]>();
      for (const proc of orderedProcesses) {
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
      | { type: "job"; group: string; displayGroup: string; folderPath?: string; jobs: RemoteJob[]; procs: DetectedProcess[] }
      | { type: "detected"; groupKey: string; displayGroup: string; folderPath: string; procs: DetectedProcess[] }
      | { type: "ungrouped"; procs: DetectedProcess[] };

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
      const detectedGroupKey = `_det_${folder}`;
      const detectedSortMode = groupLatestSortMode?.[detectedGroupKey];
      if (detectedSortMode) {
        procs.sort((left, right) => (
          processLatestTimestamp(right, detectedSortMode) - processLatestTimestamp(left, detectedSortMode)
          || compareProcessActivity(left, right)
        ));
      }
      // Merge into existing job group if one shares this folder path
      const existing = allGroups.find(
        (g) => g.type === "job" && g.folderPath === folder,
      );
      if (existing && existing.type === "job") {
        existing.procs = [...existing.procs, ...procs];
        const existingGroupSortMode = groupLatestSortMode?.[existing.group];
        if (existingGroupSortMode) {
          existing.procs.sort((left, right) => (
            processLatestTimestamp(right, existingGroupSortMode) - processLatestTimestamp(left, existingGroupSortMode)
            || compareProcessActivity(left, right)
          ));
        } else if (sortMode !== "name") {
          existing.procs.sort((left, right) => (
            processSortTimestamp(right, sortMode) - processSortTimestamp(left, sortMode)
            || compareProcessActivity(left, right)
          ));
        }
      } else {
        const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
        allGroups.push({
          type: "detected",
          groupKey: detectedGroupKey,
          displayGroup: folderName,
          folderPath: folder,
          procs,
        });
      }
    }

    if (detUngrouped.length > 0 && sortMode !== "name") {
      allGroups.push({ type: "ungrouped", procs: detUngrouped });
    }

    const ungroupedSortMode = groupLatestSortMode?.detected;
    if (ungroupedSortMode) {
      detUngrouped.sort((left, right) => (
        processLatestTimestamp(right, ungroupedSortMode) - processLatestTimestamp(left, ungroupedSortMode)
        || compareProcessActivity(left, right)
      ));
    }

    // When sorting by name, interleave all groups alphabetically
    if (sortMode === "name") {
      allGroups.sort((a, b) => {
        const da = "displayGroup" in a ? a.displayGroup : "";
        const db = "displayGroup" in b ? b.displayGroup : "";
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    } else {
      const groupSortTimestamp = (entry: GroupEntry) => {
        const processTimestamp = Math.max(
          0,
          ...entry.procs.map((process) => processSortTimestamp(process, sortMode)),
        );
        if (entry.type !== "job") return processTimestamp;
        const jobTimestamp = Math.max(
          0,
          ...entry.jobs.map((job) => jobSortTimestamp(job, statuses[job.slug], sortMode)),
        );
        return Math.max(processTimestamp, jobTimestamp);
      };
      allGroups.sort((left, right) => (
        groupSortTimestamp(right) - groupSortTimestamp(left)
        || ("displayGroup" in left ? left.displayGroup : "").localeCompare(
          "displayGroup" in right ? right.displayGroup : "",
        )
      ));
    }

    if (detUngrouped.length > 0 && sortMode === "name") {
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

    const appendGroupEntries = (entries: GroupEntry[], hidden = false) => {
      for (const entry of entries) {
        if (entry.type === "job") {
          const groupShells = matchedShellsByGroup.get(entry.group) ?? [];
          const tabCount = entry.procs.length + groupShells.length;
          const jobCount = entry.jobs.length;
          const hasTabsContent = tabCount > 0;
          const hasJobs = jobCount > 0;
          const persisted = groupTabView?.[entry.group];
          const defaultView: "tabs" | "jobs" = !hasTabsContent && hasJobs ? "jobs" : "tabs";
          let view: "tabs" | "jobs" = persisted ?? defaultView;
          if (view === "jobs" && !hasJobs) view = "tabs";
          const expanded = Boolean(query) || !collapsedGroups.has(entry.displayGroup);
          const tabsToggle = { group: entry.group, view, hasTabs: hasTabsContent, hasJobs, tabCount, jobCount };
          if (hasMultipleGroups || result.length > 0 || query) {
            result.push({ kind: "header", group: entry.displayGroup, displayGroup: entry.displayGroup, folderPath: entry.folderPath, hidden, tabsToggle });
          }
          if (expanded) {
            if (view === "jobs") {
              let jobIdx = 0;
              for (const job of entry.jobs) {
                result.push({ kind: "job", job, idx: jobIdx++ });
              }
              if (onRunAgent) {
                const groupWorkDir = entry.jobs[0]?.folder_path ?? entry.jobs[0]?.work_dir;
                if (groupWorkDir) {
                  result.push({ kind: "group-agent", workDir: groupWorkDir, footerPath: entry.folderPath });
                }
              }
            } else {
              for (const proc of entry.procs) {
                result.push({ kind: "process", process: proc, inGroup: true });
              }
              for (const shell of groupShells) {
                result.push({ kind: "shell", shell });
              }
              if (onRunAgent) {
                const groupWorkDir = entry.jobs[0]?.folder_path ?? entry.jobs[0]?.work_dir;
                if (groupWorkDir) {
                  result.push({ kind: "group-agent", workDir: groupWorkDir, footerPath: entry.folderPath });
                }
              }
            }
            if (entry.folderPath && !onRunAgent) {
              result.push({ kind: "group-footer", group: entry.displayGroup, folderPath: entry.folderPath });
            }
          }
        } else if (entry.type === "detected") {
          result.push({ kind: "header", group: entry.groupKey, displayGroup: entry.displayGroup, folderPath: entry.folderPath, hidden });
          if (query || !collapsedGroups.has(entry.groupKey)) {
            for (const proc of entry.procs) {
              result.push({ kind: "process", process: proc });
            }
            if (onRunAgent && entry.folderPath) {
              result.push({ kind: "group-agent", workDir: entry.folderPath, footerPath: entry.folderPath });
            }
            if (entry.folderPath && !onRunAgent) {
              result.push({ kind: "group-footer", group: entry.groupKey, folderPath: entry.folderPath });
            }
          }
        } else {
          result.push({ kind: "header", group: "detected", displayGroup: "Detected", hidden });
          if (query || !collapsedGroups.has("detected")) {
            for (const proc of entry.procs) {
              result.push({ kind: "process", process: proc });
            }
          }
        }
      }
    };

    appendGroupEntries(visibleGroups);

    // Add hidden groups section at the bottom
    if (hiddenEntries.length > 0) {
      result.push({ kind: "hidden-section" });
      if (query || !hiddenSectionCollapsed) {
        if (interactiveHiddenGroups) {
          appendGroupEntries(hiddenEntries, true);
        } else {
          for (const entry of hiddenEntries) {
            const displayGroup = "displayGroup" in entry ? entry.displayGroup : "Detected";
            const group = entry.type === "job" ? entry.displayGroup : entry.type === "detected" ? entry.groupKey : "detected";
            result.push({ kind: "hidden-header", group, displayGroup });
          }
        }
      }
    }

    const unmatchedShells: ShellPane[] = [];
    for (const shell of shellPanes) {
      if (!shell.matched_group || !allGroups.some((entry) => entry.type === "job" && entry.group === shell.matched_group)) {
        if (query && !matchesShellQuery(shell, query)) continue;
        unmatchedShells.push(shell);
      }
    }

    if (unmatchedShells.length > 0) {
      result.push({ kind: "header", group: "Shells", displayGroup: "Shells" });
      if (query || !collapsedGroups.has("Shells")) {
        for (const shell of unmatchedShells) {
          result.push({ kind: "shell", shell });
        }
      }
    }

    return result;
  }, [grouped, sortedGroupKeys, collapsedGroups, groupLatestSortMode, hiddenGroups, hiddenSectionCollapsed, interactiveHiddenGroups, matchedProcessesByGroup, matchedShellsByGroup, unmatchedProcesses, onRunAgent, query, shellPanes, groupTabView, pinnedRows, sortMode, statuses]);


  return {
    inferredJobSlugByPaneId,
    items: listMode === "latest" ? latestItems : groupedItems,
    groupedItems,
    latestItemCount: latestItems.filter((item) => item.kind === "job" || item.kind === "process").length,
    matchedProcessesByJob,
  };
}
