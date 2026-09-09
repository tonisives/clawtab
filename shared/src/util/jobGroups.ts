export type SavedJobGroup = {
  id: string;
  name: string;
  machine_id: string;
  work_dir: string;
};

export let savedGroupKey = (group: SavedJobGroup) => `saved:${group.id}`;

export let normalizeGroupPath = (path: string) => path.replace(/\/+$/, "") || "/";

export let matchesSavedGroup = (
  group: SavedJobGroup,
  cwd: string,
  machineId: string | null | undefined,
) => Boolean(cwd) && group.machine_id === machineId && normalizeGroupPath(group.work_dir) === normalizeGroupPath(cwd);
