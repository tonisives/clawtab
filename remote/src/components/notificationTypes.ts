
export type NotificationDetailTarget =
  | {
      kind: "job";
      jobName: string;
      paneId?: string;
    }
  | {
      kind: "process";
      paneId: string;
    };
