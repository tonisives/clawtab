import { useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import type { Transport, RemoteJob, JobStatus } from "@clawtab/shared";
import { JobDetailView, shortenPath } from "@clawtab/shared";
import { XtermPane } from "./XtermPane";

function createProcessTransport(process: ClaudeProcess): Transport {
  const noopRunJob: Transport["runJob"] = async () => null;
  const noopVoid = async () => {};
  const paneId = process.pane_id;
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
        tmuxSession: process.tmux_session,
        windowName: process.window_name,
      });
    },
  };
}

export function DetectedProcessDetail({
  process,
  questions,
  onBack,
  onDismissQuestion,
  autoYesActive,
  onToggleAutoYes,
  showBackButton = false,
  hidePath = false,
  onStopped,
  onEditFirstQuery,
  onEditLastQuery,
  onFork,
  onSplitPane,
  onInjectSecrets,
  onSearchSkills,
  contentStyle,
  titlePath,
}: {
  process: ClaudeProcess;
  questions: ClaudeQuestion[];
  onBack: () => void;
  onDismissQuestion: (questionId: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  showBackButton?: boolean;
  hidePath?: boolean;
  onStopped?: () => void;
  onEditFirstQuery?: () => void;
  onEditLastQuery?: () => void;
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  contentStyle?: unknown;
  titlePath?: string;
}) {
  const processRef = useRef(process);
  processRef.current = process;
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  const displayName = process.display_name ?? shortenPath(process.cwd);

  const paneQuestion = questions.find((q) => q.pane_id === process.pane_id);

  const transport = useMemo(() => createProcessTransport(process), [process.pane_id]);

  const syntheticJob: RemoteJob = {
    name: displayName,
    job_type: process.process_type ?? "claude",
    enabled: true,
    cron: "",
    group: "detected",
    slug: process.pane_id,
    work_dir: process.cwd,
  };

  const syntheticStatus: JobStatus = {
    state: "running",
    run_id: "",
    started_at: process.session_started_at ?? "",
    pane_id: process.pane_id,
  };

  const handleOpen = useCallback(() => {
    invoke("focus_detected_process", {
      tmuxSession: process.tmux_session,
      windowName: process.window_name,
    }).catch(() => {});
  }, [process.tmux_session, process.window_name]);

  const handleSendInput = useCallback(async (_name: string, text: string) => {
    await invoke("send_detected_process_input", { paneId: process.pane_id, text });
    if (paneQuestion) onDismissQuestion(paneQuestion.question_id);
  }, [process.pane_id, paneQuestion, onDismissQuestion]);

  // Override transport methods: sendInput for question dismissal, stop/sigint for adjacent selection
  const wrappedTransport = useMemo((): Transport => ({
    ...transport,
    sendInput: handleSendInput,
    stopJob: async (...args: Parameters<Transport["stopJob"]>) => {
      onStoppedRef.current?.();
      return transport.stopJob(...args);
    },
    sigintJob: transport.sigintJob ? async (...args: Parameters<NonNullable<Transport["sigintJob"]>>) => {
      onStoppedRef.current?.();
      return transport.sigintJob!(...args);
    } : undefined,
  }), [transport, handleSendInput]);

  const renderTerminal = useCallback(
    () => (
      <XtermPane
        paneId={process.pane_id}
        tmuxSession={process.tmux_session}
        group={process.matched_group ?? "default"}
      />
    ),
    [process.pane_id, process.tmux_session, process.matched_group],
  );

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
      titlePath={titlePath}
      options={paneQuestion?.options}
      questionContext={paneQuestion?.context_lines}
      autoYesActive={autoYesActive}
      onToggleAutoYes={onToggleAutoYes}
      renderTerminal={renderTerminal}
      hideMessageInput
      firstQuery={process.first_query ?? undefined}
      lastQuery={process.last_query ?? undefined}
      onEditFirstQuery={onEditFirstQuery}
      onEditLastQuery={onEditLastQuery}
      onFork={onFork}
      onSplitPane={onSplitPane}
      onInjectSecrets={onInjectSecrets}
      onSearchSkills={onSearchSkills}
    />
  );
}
