import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DetectedProcess, ClaudeQuestion } from "@clawtab/shared";
import type { Transport, RemoteJob, JobStatus } from "@clawtab/shared";
import { JobDetailView, shortenPath } from "@clawtab/shared";
import { XtermPane } from "./XtermPane";

type AgentActionDescriptor = {
  id: string;
  title: string;
  description: string;
  available: boolean;
  unavailable_reason?: string;
  parameters: {
    name: string;
    kind: "model" | "effort";
    required: boolean;
    options: string[];
  }[];
};

type AgentActionRun = {
  run_id: string;
  pane_id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "needs_user_attention";
  progress: string;
  error?: string;
};


function createProcessTransport(process: DetectedProcess): Transport {
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
  onFork,
  onSplitPane,
  onZoomPane,
  onInjectSecrets,
  onSearchSkills,
  contentStyle,
  titlePath,
  displayNameOverride,
  dragHandleProps,
}: {
  process: DetectedProcess;
  questions: ClaudeQuestion[];
  onBack: () => void;
  onDismissQuestion: (questionId: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  showBackButton?: boolean;
  hidePath?: boolean;
  onStopped?: () => void;
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onZoomPane?: () => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  contentStyle?: unknown;
  titlePath?: string;
  displayNameOverride?: string | null;
  dragHandleProps?: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown>;
    isDragging?: boolean;
  };
}) {
  const processRef = useRef(process);
  processRef.current = process;
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  const displayName = displayNameOverride?.trim() || (process.display_name ?? shortenPath(process.cwd));

  const paneQuestion = questions.find((q) => q.pane_id === process.pane_id);

  const transport = useMemo(() => createProcessTransport(process), [process.pane_id]);
  const [agentActions, setAgentActions] = useState<AgentActionDescriptor[]>([]);
  const [agentActionRun, setAgentActionRun] = useState<AgentActionRun | null>(null);

  useEffect(() => {
    let active = true;
    invoke<[AgentActionDescriptor[], unknown]>("list_agent_actions", {
      paneId: process.pane_id,
    }).then(([actions]) => {
      if (active) {
        setAgentActions(actions);
      }
    }).catch(() => {
      if (active) setAgentActions([]);
    });
    return () => { active = false; };
  }, [process.pane_id]);

  useEffect(() => {
    if (!agentActionRun || !["queued", "running"].includes(agentActionRun.state)) return;
    let active = true;
    const poll = () => {
      invoke<AgentActionRun>("get_agent_action_run", { runId: agentActionRun.run_id })
        .then((run) => { if (active) setAgentActionRun(run); })
        .catch(() => {});
    };
    const interval = setInterval(poll, 750);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [agentActionRun?.run_id, agentActionRun?.state]);

  useEffect(() => {
    const unlisten = listen<AgentActionRun>("agent-action-progress", (event) => {
      if (event.payload.pane_id === process.pane_id) setAgentActionRun(event.payload);
    });
    return () => { unlisten.then((stop) => stop()); };
  }, [process.pane_id]);

  const runAgentAction = useCallback((actionId: string, parameters: Record<string, string> = {}) => {
    invoke<AgentActionRun>("start_agent_action", {
      paneId: process.pane_id,
      actionId,
      parameters,
    }).then(setAgentActionRun).catch((error) => {
      setAgentActionRun({
        run_id: "start-error",
        pane_id: process.pane_id,
        state: "failed",
        progress: "Could not start action",
        error: String(error),
      });
    });
  }, [process.pane_id]);

  const agentMenuItems = useMemo(() => {
    const items: { label: string; onPress: () => void }[] = [];
    if (agentActionRun && ["queued", "running"].includes(agentActionRun.state)) {
      items.push({
        label: `Agent: ${agentActionRun.progress}`,
        onPress: () => {
          invoke("cancel_agent_action", { runId: agentActionRun.run_id }).catch(() => {});
        },
      });
      return items;
    }
    for (const action of agentActions.filter((candidate) => candidate.available)) {
      const modelParameter = action.parameters.find((parameter) => parameter.kind === "model");
      const effortParameter = action.parameters.find((parameter) => parameter.kind === "effort");
      const models = modelParameter?.options;
      const efforts = effortParameter?.options ?? [];
      if (models?.length) {
        if (effortParameter?.required && efforts.length === 0) continue;
        for (const model of models) {
          if (efforts.length) {
            for (const effort of efforts) {
              items.push({
                label: `Agent: Switch to ${model} (${effort})`,
                onPress: () => runAgentAction(action.id, { model, effort }),
              });
            }
          } else {
            items.push({
              label: `Agent: Switch to ${model}`,
              onPress: () => runAgentAction(action.id, { model }),
            });
          }
        }
      } else {
        items.push({ label: `Agent: ${action.title}`, onPress: () => runAgentAction(action.id) });
      }
    }
    if (agentActionRun?.error) {
      items.unshift({ label: `Agent action failed: ${agentActionRun.error}`, onPress: () => {} });
    }
    return items;
  }, [agentActionRun, agentActions, runAgentAction]);

  const syntheticJob: RemoteJob = {
    name: displayName,
    job_type: process.provider,
    agent_provider: process.provider,
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
    sigintJob: transport.sigintJob ? async (...args: Parameters<NonNullable<Transport["sigintJob"]>>) => (
      transport.sigintJob!(...args)
    ) : undefined,
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
      tokenCount={process.token_count}
      onFork={process.can_fork_session ? onFork : undefined}
      onSplitPane={onSplitPane}
      onZoomPane={onZoomPane}
      onInjectSecrets={process.can_inject_secrets ? onInjectSecrets : undefined}
      onSearchSkills={process.can_send_skills ? onSearchSkills : undefined}
      dragHandleProps={dragHandleProps}
      extraMenuItems={agentMenuItems}
    />
  );
}
