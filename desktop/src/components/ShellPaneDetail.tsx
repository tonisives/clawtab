import { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RemoteJob, JobStatus, ShellPane, Transport } from "@clawtab/shared";
import { JobDetailView, shortenPath } from "@clawtab/shared";
import { XtermPane } from "./XtermPane";

function createShellTransport(shell: ShellPane): Transport {
  const paneId = shell.pane_id;
  const noopRunJob: Transport["runJob"] = async () => null;
  const noopVoid = async () => {};
  return {
    listJobs: async () => ({ jobs: [], statuses: {} }),
    getStatuses: async () => ({}),
    runJob: noopRunJob,
    stopJob: async () => {
      await invoke("stop_detected_process", { paneId });
    },
    pauseJob: noopVoid,
    resumeJob: noopVoid,
    toggleJob: noopVoid,
    deleteJob: noopVoid,
    getRunHistory: async () => [],
    getRunDetail: async () => null,
    detectProcesses: async () => [],
    sendInput: async (_name: string, text: string) => {
      await invoke("send_detected_process_input", { paneId, text });
    },
    subscribeLogs: () => () => {},
    runAgent: async () => null,
    sigintJob: async () => {
      await invoke("sigint_detected_process", { paneId });
    },
    focusJobWindow: async () => {
      await invoke("focus_detected_process", {
        tmuxSession: shell.tmux_session,
        windowName: shell.window_name,
      });
    },
  };
}

export function ShellPaneDetail({
  shell,
  onBack,
  showBackButton = false,
  hidePath = false,
  onStopped,
  onSplitPane,
  contentStyle,
  titlePath,
}: {
  shell: ShellPane;
  onBack: () => void;
  showBackButton?: boolean;
  hidePath?: boolean;
  onStopped?: () => void;
  onSplitPane?: (direction: "right" | "down") => void;
  contentStyle?: unknown;
  titlePath?: string;
}) {
  const transport = useMemo(() => createShellTransport(shell), [shell]);

  const syntheticJob: RemoteJob = {
    name: shortenPath(shell.cwd),
    job_type: "shell",
    enabled: true,
    cron: "",
    group: "shell",
    slug: shell.pane_id,
    work_dir: shell.cwd,
  };

  const syntheticStatus: JobStatus = {
    state: "running",
    run_id: "",
    started_at: "",
    pane_id: shell.pane_id,
  };

  const handleOpen = useCallback(() => {
    invoke("focus_detected_process", {
      tmuxSession: shell.tmux_session,
      windowName: shell.window_name,
    }).catch(() => {});
  }, [shell.tmux_session, shell.window_name]);

  const renderTerminal = useCallback(
    () => (
      <XtermPane
        paneId={shell.pane_id}
        tmuxSession={shell.tmux_session}
        group="default"
        onExit={onStopped}
      />
    ),
    [shell.pane_id, shell.tmux_session, onStopped],
  );

  return (
    <JobDetailView
      transport={transport}
      job={syntheticJob}
      status={syntheticStatus}
      logs=""
      runs={[]}
      runsLoading={false}
      onBack={onBack}
      onOpen={handleOpen}
      showBackButton={showBackButton}
      hidePath={hidePath}
      hideRuns
      expandOutput
      containerStyle={{ backgroundColor: "var(--bg-primary)", borderRadius: 0 } as any}
      contentStyle={contentStyle as any}
      titlePath={titlePath}
      renderTerminal={renderTerminal}
      hideMessageInput
      onSplitPane={onSplitPane}
    />
  );
}
