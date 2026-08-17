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

export function notificationJobRoute(jobName: string) {
  return {
    pathname: "/notifications/job/[name]",
    params: { name: jobName },
  } as const;
}

export function notificationProcessRoute(paneId: string) {
  return {
    pathname: "/notifications/process/[pane_id]",
    params: {
      pane_id: paneId.replace(/%/g, "_pct_"),
      source: "notifications",
    },
  } as const;
}
