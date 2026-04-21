import { useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeQuestion, DetectedProcess, RemoteJob, ShellPane, Transport, JobStatus } from "@clawtab/shared";
import { JobDetailView, shortenPath } from "@clawtab/shared";
import { XtermPane } from "./XtermPane";

type TmuxPaneTarget =
  | { kind: "process"; process: DetectedProcess }
  | { kind: "shell"; shell: ShellPane };

function createPaneTransport(paneId: string, tmuxSession: string, windowName: string): Transport {
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
      await invoke("focus_detected_process", { tmuxSession, windowName });
    },
  };
}

export function TmuxPaneDetail({
  target,
  questions = [],
  onBack,
  onDismissQuestion,
  autoYesActive,
  onToggleAutoYes,
  autoYesShortcut,
  showBackButton = false,
  hidePath = false,
  onStopped,
  onFork,
  onSplitPane,
  onZoomPane,
  onInjectSecrets,
  onSearchSkills,
  contentStyle,
  headerLeftInset,
  titlePath,
  displayNameOverride,
  dragHandleProps,
}: {
  target: TmuxPaneTarget;
  questions?: ClaudeQuestion[];
  onBack: () => void;
  onDismissQuestion?: (questionId: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  autoYesShortcut?: string;
  showBackButton?: boolean;
  hidePath?: boolean;
  onStopped?: () => void;
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onZoomPane?: () => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  contentStyle?: unknown;
  headerLeftInset?: number;
  titlePath?: string;
  displayNameOverride?: string | null;
  dragHandleProps?: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown>;
    isDragging?: boolean;
  };
}) {
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  const paneId = target.kind === "process" ? target.process.pane_id : target.shell.pane_id;
  const cwd = target.kind === "process" ? target.process.cwd : target.shell.cwd;
  const tmuxSession = target.kind === "process" ? target.process.tmux_session : target.shell.tmux_session;
  const windowName = target.kind === "process" ? target.process.window_name : target.shell.window_name;
  const matchedGroup = target.kind === "process" ? target.process.matched_group : target.shell.matched_group;
  const paneQuestion = target.kind === "process"
    ? questions.find((q) => q.pane_id === target.process.pane_id)
    : undefined;

  const transport = useMemo(
    () => createPaneTransport(paneId, tmuxSession, windowName),
    [paneId, tmuxSession, windowName],
  );

  const displayName = target.kind === "process"
    ? displayNameOverride?.trim() || (target.process.display_name ?? target.process.pane_title ?? shortenPath(target.process.cwd))
    : target.shell.display_name ?? target.shell.pane_title ?? shortenPath(target.shell.cwd);
  const jobType = target.kind === "process" ? target.process.provider : "shell";

  const syntheticJob: RemoteJob = {
    name: displayName,
    job_type: jobType,
    agent_provider: target.kind === "process" ? target.process.provider : undefined,
    enabled: true,
    cron: "",
    group: target.kind === "process" ? "detected" : "shell",
    slug: paneId,
    work_dir: cwd,
  };

  const syntheticStatus: JobStatus = {
    state: "running",
    run_id: "",
    started_at: target.kind === "process" ? target.process.session_started_at ?? "" : "",
    pane_id: paneId,
  };

  const handleOpen = useCallback(() => {
    invoke("focus_detected_process", { tmuxSession, windowName }).catch(() => {});
  }, [tmuxSession, windowName]);

  const handleSendInput = useCallback(async (_name: string, text: string) => {
    await invoke("send_detected_process_input", { paneId, text });
    if (paneQuestion && onDismissQuestion) onDismissQuestion(paneQuestion.question_id);
  }, [paneId, paneQuestion, onDismissQuestion]);

  const wrappedTransport = useMemo((): Transport => ({
    ...transport,
    sendInput: handleSendInput,
    stopJob: async (...args: Parameters<Transport["stopJob"]>) => {
      onStoppedRef.current?.();
      return transport.stopJob(...args);
    },
    sigintJob: transport.sigintJob ? async (...args: Parameters<NonNullable<Transport["sigintJob"]>>) => (
      transport.sigintJob!(...args)
    ) : undefined,
  }), [transport, handleSendInput]);

  const renderTerminal = useCallback(
    () => (
      <XtermPane
        paneId={paneId}
        tmuxSession={tmuxSession}
        group={matchedGroup ?? "default"}
      />
    ),
    [paneId, tmuxSession, matchedGroup],
  );

  const process = target.kind === "process" ? target.process : null;

  const debugMenuItems = useMemo(() => [
    {
      label: "Debug: Refresh Snapshot",
      onPress: () => {
        console.log(`[Debug] refresh snapshot for ${paneId}`);
        invoke("pty_refresh_snapshot", { paneId }).then(
          () => console.log(`[Debug] refresh snapshot OK`),
          (e: unknown) => console.warn(`[Debug] refresh snapshot failed:`, e),
        );
      },
    },
    {
      label: "Debug: Re-spawn PTY",
      onPress: async () => {
        console.log(`[Debug] re-spawn for ${paneId}`);
        await invoke("pty_destroy", { paneId }).catch((e: unknown) => console.warn(`[Debug] destroy failed:`, e));
        const result = await invoke("pty_spawn", {
          paneId, tmuxSession, cols: 120, rows: 40, group: matchedGroup ?? "default",
        }).catch((e: unknown) => { console.warn(`[Debug] spawn failed:`, e); return null; });
        console.log(`[Debug] re-spawn result:`, result);
      },
    },
    {
      label: "Debug: Log PTY State",
      onPress: async () => {
        const cached = await invoke<number[]>("pty_get_cached_output", { paneId }).catch(() => []);
        console.log(`[Debug] paneId=${paneId} cachedBytes=${cached.length}`);
      },
    },
  ], [paneId, tmuxSession, matchedGroup]);

  return (
    <JobDetailView
      transport={wrappedTransport}
      job={syntheticJob}
      status={syntheticStatus}
      logs=""
      runs={[]}
      runsLoading={false}
      onBack={onBack}
      showBackButton={showBackButton}
      hidePath={hidePath}
      onOpen={handleOpen}
      hideRuns
      expandOutput
      containerStyle={{ backgroundColor: "var(--bg-primary)", borderRadius: 0 } as any}
      contentStyle={contentStyle as any}
      headerLeftInset={headerLeftInset}
      titlePath={titlePath}
      options={paneQuestion?.options}
      questionContext={paneQuestion?.context_lines}
      autoYesActive={autoYesActive}
      onToggleAutoYes={onToggleAutoYes}
      autoYesShortcut={autoYesShortcut}
      renderTerminal={renderTerminal}
      hideMessageInput
      firstQuery={process?.first_query ?? undefined}
      lastQuery={process?.last_query ?? undefined}
      tokenCount={process?.token_count}
      onFork={process?.can_fork_session ? onFork : undefined}
      onSplitPane={onSplitPane}
      onZoomPane={onZoomPane}
      onInjectSecrets={process?.can_inject_secrets ? onInjectSecrets : undefined}
      onSearchSkills={process?.can_send_skills ? onSearchSkills : undefined}
      dragHandleProps={dragHandleProps}
      extraMenuItems={debugMenuItems}
    />
  );
}
