export function jobRoute(jobName: string) {
  return {
    pathname: "/job/[name]",
    params: { name: jobName },
  } as const;
}

export function processRoute(paneId: string, options?: { preserveTerminal?: boolean }) {
  return {
    pathname: "/process/[pane_id]",
    params: {
      pane_id: paneId.replace(/%/g, "_pct_"),
      ...(options?.preserveTerminal ? { source: "notifications" } : {}),
    },
  } as const;
}
