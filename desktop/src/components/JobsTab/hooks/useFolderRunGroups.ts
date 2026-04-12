import { useMemo } from "react";
import type { useJobsCore } from "@clawtab/shared";
import type { Job } from "../../../types";

export function useFolderRunGroups(core: ReturnType<typeof useJobsCore>) {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: { group: string; folderPath: string }[] = [];
    for (const job of core.jobs as Job[]) {
      const folderPath = (job.folder_path ?? job.work_dir)?.replace(/\/+$/, "");
      if (!folderPath || seen.has(folderPath)) continue;
      seen.add(folderPath);
      out.push({
        group: job.group && job.group !== "default"
          ? job.group
          : folderPath.split("/").filter(Boolean).pop() ?? "General",
        folderPath,
      });
    }
    return out;
  }, [core.jobs]);
}
