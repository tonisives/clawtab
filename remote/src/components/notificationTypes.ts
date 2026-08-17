import type { DetectedProcess } from "@clawtab/shared";

export type NotificationDetailTarget =
  | {
      kind: "job";
      jobName: string;
      paneId?: string;
      isDemo?: boolean;
    }
  | {
      kind: "process";
      paneId: string;
      demoProcess?: DetectedProcess;
    };
