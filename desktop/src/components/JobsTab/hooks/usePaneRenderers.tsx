import { useCallback } from "react";
import type { RemoteJob, ClaudeQuestion, PaneContent, DetectedProcess, ProcessProvider, Transport } from "@clawtab/shared";
import { shortenPath, type useJobsCore, type useSplitTree } from "@clawtab/shared";
import { DesktopJobDetail, AgentDetail } from "../../JobDetailSections";
import { DraggableSplitPane } from "../../DraggableCards";
import { EmptyDetailAgent } from "../../EmptyDetailAgent";
import { TmuxPaneDetail } from "../../TmuxPaneDetail";
import type { Job } from "../../../types";
import type { useViewingState } from "./useViewingState";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useQuestionPolling } from "../../../hooks/useQuestionPolling";
import type { useJobActions } from "@clawtab/shared";

interface PaneCallbacks {
  handleOpen: (slug: string) => void;
  handleDuplicate: (job: Job, group: string) => void;
  handleDuplicateToFolder: (job: Job) => void;
  handleFork: (paneId: string, direction: "right" | "down") => void;
  handleSplitPane: (paneId: string, direction: "right" | "down") => void;
  handleRunAgent: (prompt: string, workDir?: string, provider?: ProcessProvider) => void | Promise<void>;
  handleGetAgentProviders: () => Promise<ProcessProvider[]>;
  selectAdjacentItem: (currentId: string) => void;
  openRenameProcessDialog: (process: DetectedProcess) => void;
  buildJobPaneActions: (job: Job, jobQuestion: ClaudeQuestion | undefined) => Record<string, unknown>;
  buildJobTitlePath: (job: Job, jobQuestion: ClaudeQuestion | undefined) => string | undefined;
  buildProcessTitlePath: (process: DetectedProcess) => string;
  setEditingJob: (job: Job | null) => void;
  setSkillSearchPaneId: (paneId: string | null) => void;
  setInjectSecretsPaneId: (paneId: string | null) => void;
  processRenameDrafts: Record<string, string | null>;
  folderRunGroups: { group: string; folderPath: string }[];
}

interface UsePaneRenderersParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  actions: ReturnType<typeof useJobActions>;
  questions: ClaudeQuestion[];
  questionPolling: ReturnType<typeof useQuestionPolling>;
  autoYes: ReturnType<typeof useAutoYes>;
  transport: Transport;
  agentJob: RemoteJob;
  agentProcess: DetectedProcess | null;
  isWide: boolean;
  trafficLightInsetStyle: { paddingLeft: number } | undefined;
  defaultProvider: ProcessProvider;
  defaultModel?: string | null;
  enabledModels?: Record<string, string[]>;
  callbacks: PaneCallbacks;
}

export function usePaneRenderers({
  core, split, viewing, lifecycle, actions,
  questions, questionPolling, autoYes, transport,
  agentJob, agentProcess,
  isWide, trafficLightInsetStyle, defaultProvider, defaultModel, enabledModels,
  callbacks,
}: UsePaneRenderersParams) {
  const {
    pendingProcess, setPendingProcess, setPendingAgentWorkDir,
    stoppingProcesses, setStoppingProcesses,
    setStoppingJobSlugs, setShellPanes, demotedShellPaneIdsRef, shellPanes,
  } = lifecycle;
  const {
    setViewingJob, setViewingProcess, setViewingShell, setViewingAgent,
    focusEmptyAgentSignal,
  } = viewing;
  const {
    handleOpen, handleDuplicate, handleDuplicateToFolder,
    handleFork, handleSplitPane,
    handleRunAgent, handleGetAgentProviders,
    selectAdjacentItem, openRenameProcessDialog,
    buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath,
    setEditingJob, setSkillSearchPaneId, setInjectSecretsPaneId,
    processRenameDrafts, folderRunGroups,
  } = callbacks;

  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    if (content.kind === "agent") {
      return (
        <DraggableSplitPane leafId={leafId} content={content}>
          {(dragHandleProps) => (
            <AgentDetail
              transport={transport}
              job={agentJob}
              status={core.statuses["agent"] ?? { state: "idle" as const }}
              onBack={() => split.handleClosePane(leafId)}
              onOpen={() => handleOpen("agent")}
              onEditTitle={agentProcess ? () => openRenameProcessDialog(agentProcess) : undefined}
              onZoomPane={() => split.toggleZoomLeaf(leafId)}
              showBackButton={!isWide}
              hidePath
              contentStyle={trafficLightInsetStyle}
              titlePath={agentProcess ? buildProcessTitlePath(agentProcess) : "Agent"}
              dragHandleProps={dragHandleProps}
            />
          )}
        </DraggableSplitPane>
      );
    }

    if (content.kind === "terminal") {
      const proc = core.processes.find((p) => p.pane_id === content.paneId)
        ?? stoppingProcesses.find((sp) => sp.process.pane_id === content.paneId)?.process;
      const shell = shellPanes.find((p) => p.pane_id === content.paneId);
      if (!shell && !proc) {
        return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Tmux pane not found</span></div>;
      }
      if (proc) {
        return (
          <DraggableSplitPane leafId={leafId} content={content}>
            {(dragHandleProps) => (
              <TmuxPaneDetail
                target={{ kind: "process", process: proc }}
                questions={questions}
                onBack={() => split.handleClosePane(leafId)}
                onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
                autoYesActive={autoYes.autoYesPaneIds.has(proc.pane_id)}
                onToggleAutoYes={() => {
                  const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
                  if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
                  else autoYes.handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
                }}
                showBackButton={!isWide} hidePath
                onStopped={() => {
                  setStoppingProcesses((prev) => {
                    if (prev.some((sp) => sp.process.pane_id === proc.pane_id)) return prev;
                    return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
                  });
                  core.requestFastPoll(`pane:${proc.pane_id}`);
                }}
                onFork={(direction: "right" | "down") => handleFork(proc.pane_id, direction)}
                onSplitPane={(direction: "right" | "down") => handleSplitPane(proc.pane_id, direction)}
                onZoomPane={() => split.toggleZoomLeaf(leafId)}
                onInjectSecrets={() => setInjectSecretsPaneId(proc.pane_id)}
                onSearchSkills={() => setSkillSearchPaneId(proc.pane_id)}
                contentStyle={trafficLightInsetStyle}
                titlePath={buildProcessTitlePath(proc)}
                displayNameOverride={processRenameDrafts[proc.pane_id] ?? null}
                dragHandleProps={dragHandleProps}
              />
            )}
          </DraggableSplitPane>
        );
      }
      if (!shell) return null;
      return (
        <DraggableSplitPane leafId={leafId} content={content}>
          {(dragHandleProps) => (
            <TmuxPaneDetail
              target={{ kind: "shell", shell }}
              onBack={() => split.handleClosePane(leafId)}
              showBackButton={!isWide}
              hidePath
              onStopped={() => {
                demotedShellPaneIdsRef.current.delete(shell.pane_id);
                setShellPanes((prev) => prev.filter((p) => p.pane_id !== shell.pane_id));
                split.handleClosePane(leafId);
              }}
              onSplitPane={(nextDirection: "right" | "down") => handleSplitPane(shell.pane_id, nextDirection)}
              onZoomPane={() => split.toggleZoomLeaf(leafId)}
              contentStyle={trafficLightInsetStyle}
              titlePath={shortenPath(shell.cwd)}
              dragHandleProps={dragHandleProps}
            />
          )}
        </DraggableSplitPane>
      );
    }

    if (content.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === content.paneId)
        ?? stoppingProcesses.find((sp) => sp.process.pane_id === content.paneId)?.process
        ?? (pendingProcess?.pane_id === content.paneId ? pendingProcess : null);
      if (!proc) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span></div>;
      if (proc.pane_id.startsWith("_pending_")) {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); split.handleClosePane(leafId); }}>Back</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
            </div>
          </div>
        );
      }
      return (
        <DraggableSplitPane leafId={leafId} content={content}>
          {(dragHandleProps) => (
            <TmuxPaneDetail
              target={{ kind: "process", process: proc }}
              questions={questions}
              onBack={() => split.handleClosePane(leafId)}
              onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
              autoYesActive={autoYes.autoYesPaneIds.has(proc.pane_id)}
              onToggleAutoYes={() => {
                const paneQuestion = questions.find((q) => q.pane_id === proc.pane_id);
                if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
                else autoYes.handleToggleAutoYesByPaneId(proc.pane_id, proc.cwd.replace(/^\/Users\/[^/]+/, "~"));
              }}
              showBackButton={!isWide} hidePath
              onStopped={() => {
                setStoppingProcesses((prev) => {
                  if (prev.some((sp) => sp.process.pane_id === proc.pane_id)) return prev;
                  return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
                });
                core.requestFastPoll(`pane:${proc.pane_id}`);
              }}
              onFork={(direction: "right" | "down") => handleFork(proc.pane_id, direction)}
              onSplitPane={(direction: "right" | "down") => handleSplitPane(proc.pane_id, direction)}
              onZoomPane={() => split.toggleZoomLeaf(leafId)}
              onInjectSecrets={() => setInjectSecretsPaneId(proc.pane_id)}
              onSearchSkills={() => setSkillSearchPaneId(proc.pane_id)}
              contentStyle={trafficLightInsetStyle}
              titlePath={buildProcessTitlePath(proc)}
              displayNameOverride={processRenameDrafts[proc.pane_id] ?? null}
              dragHandleProps={dragHandleProps}
            />
          )}
        </DraggableSplitPane>
      );
    }

    const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
    if (!job) return <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}><span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span></div>;
    const jobQuestion = questions.find((q) => q.matched_job === job.slug);
    const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);
    return (
      <DraggableSplitPane leafId={leafId} content={content}>
        {(dragHandleProps) => (
          <DesktopJobDetail
            transport={transport} job={job}
            status={core.statuses[job.slug] ?? { state: "idle" as const }}
            firstQuery={matchedProcess?.first_query ?? undefined}
            lastQuery={matchedProcess?.last_query ?? undefined}
            onBack={() => split.handleClosePane(leafId)}
            onEdit={() => { setEditingJob(job); split.handleClosePane(leafId); }}
            onOpen={() => handleOpen(job.slug)}
            onToggle={() => { actions.toggleJob(job.slug); core.reload(); }}
            onDuplicate={(group: string) => handleDuplicate(job, group)}
            onDuplicateToFolder={() => handleDuplicateToFolder(job)}
            onDelete={() => { split.handleClosePane(leafId); actions.deleteJob(job.slug); core.reload(); }}
            groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
            showBackButton={!isWide} hidePath
            options={jobQuestion?.options}
            questionContext={jobQuestion?.context_lines}
            {...buildJobPaneActions(job, jobQuestion)}
            onStopping={() => {
              setStoppingJobSlugs((prev) => new Set(prev).add(job.slug));
              core.requestFastPoll(`job:${job.slug}`);
            }}
            contentStyle={trafficLightInsetStyle}
            titlePath={buildJobTitlePath(job, jobQuestion)}
            dragHandleProps={dragHandleProps}
            defaultAgentProvider={defaultProvider}
          />
        )}
      </DraggableSplitPane>
    );
  }, [agentJob, agentProcess, core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, handleSplitPane, questionPolling, buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath, split.handleClosePane, split.toggleZoomLeaf, isWide, trafficLightInsetStyle, pendingProcess, shellPanes, openRenameProcessDialog, processRenameDrafts, stoppingProcesses, setStoppingProcesses, setStoppingJobSlugs, demotedShellPaneIdsRef, setShellPanes, setPendingAgentWorkDir, setPendingProcess, setEditingJob, setSkillSearchPaneId, setInjectSecretsPaneId, defaultProvider, transport]);

  const renderSinglePaneContent = useCallback((content: PaneContent) => {
    if (content.kind === "agent") {
      return (
        <AgentDetail
          transport={transport}
          job={agentJob}
          status={core.statuses["agent"] ?? { state: "idle" as const }}
          onBack={() => setViewingAgent(false)}
          onOpen={() => handleOpen("agent")}
          onEditTitle={agentProcess ? () => openRenameProcessDialog(agentProcess) : undefined}
          onZoomPane={() => split.toggleZoomLeaf("")}
          showBackButton={!isWide}
          hidePath
          contentStyle={trafficLightInsetStyle}
          titlePath={agentProcess ? buildProcessTitlePath(agentProcess) : "Agent"}
        />
      );
    }

    if (content.kind === "process") {
      const singleProcess = core.processes.find((p) => p.pane_id === content.paneId)
        ?? (pendingProcess?.pane_id === content.paneId ? pendingProcess : null);
      if (singleProcess && pendingProcess && singleProcess.pane_id === pendingProcess.pane_id
          && singleProcess.pane_id.startsWith("_pending_")) {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn btn-sm" onClick={() => { setPendingAgentWorkDir(null); setPendingProcess(null); setViewingProcess(null); }}>Back</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
            </div>
          </div>
        );
      }
      if (!singleProcess) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Process not found</span>
          </div>
        );
      }
      return (
          <TmuxPaneDetail
            target={{ kind: "process", process: singleProcess }}
            questions={questions}
            onBack={() => setViewingProcess(null)}
            onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
            autoYesActive={autoYes.autoYesPaneIds.has(singleProcess.pane_id)}
            onToggleAutoYes={() => {
              const paneQuestion = questions.find((q) => q.pane_id === singleProcess.pane_id);
              if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
              else autoYes.handleToggleAutoYesByPaneId(singleProcess.pane_id, singleProcess.cwd.replace(/^\/Users\/[^/]+/, "~"));
            }}
            showBackButton={!isWide} hidePath
            onStopped={() => {
              setStoppingProcesses((prev) => {
                if (prev.some((sp) => sp.process.pane_id === singleProcess.pane_id)) return prev;
                return [...prev, { process: { ...singleProcess, _transient_state: "stopping" }, stoppedAt: Date.now() }];
              });
              core.requestFastPoll(`pane:${singleProcess.pane_id}`);
              selectAdjacentItem(singleProcess.pane_id);
            }}
            onFork={(direction: "right" | "down") => handleFork(singleProcess.pane_id, direction)}
            onSplitPane={(direction: "right" | "down") => handleSplitPane(singleProcess.pane_id, direction)}
            onZoomPane={() => split.toggleZoomLeaf("")}
            onInjectSecrets={() => setInjectSecretsPaneId(singleProcess.pane_id)}
            onSearchSkills={() => setSkillSearchPaneId(singleProcess.pane_id)}
            contentStyle={trafficLightInsetStyle}
            titlePath={buildProcessTitlePath(singleProcess)}
            displayNameOverride={processRenameDrafts[singleProcess.pane_id] ?? null}
          />
      );
    }

    if (content.kind === "terminal") {
      const singleProcess = core.processes.find((p) => p.pane_id === content.paneId);
      const singleShell = shellPanes.find((p) => p.pane_id === content.paneId);
      if (!singleShell && !singleProcess) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Tmux pane not found</span>
          </div>
        );
      }
      if (singleProcess) {
        return (
          <TmuxPaneDetail
            target={{ kind: "process", process: singleProcess }}
            questions={questions}
            onBack={() => setViewingProcess(null)}
            onDismissQuestion={(qId) => questionPolling.dismissQuestion(qId)}
            autoYesActive={autoYes.autoYesPaneIds.has(singleProcess.pane_id)}
            onToggleAutoYes={() => {
              const paneQuestion = questions.find((q) => q.pane_id === singleProcess.pane_id);
              if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
              else autoYes.handleToggleAutoYesByPaneId(singleProcess.pane_id, singleProcess.cwd.replace(/^\/Users\/[^/]+/, "~"));
            }}
            showBackButton={!isWide} hidePath
            onStopped={() => {
              setStoppingProcesses((prev) => {
                if (prev.some((sp) => sp.process.pane_id === singleProcess.pane_id)) return prev;
                return [...prev, { process: { ...singleProcess, _transient_state: "stopping" }, stoppedAt: Date.now() }];
              });
              core.requestFastPoll(`pane:${singleProcess.pane_id}`);
              selectAdjacentItem(singleProcess.pane_id);
            }}
            onFork={(direction: "right" | "down") => handleFork(singleProcess.pane_id, direction)}
            onSplitPane={(direction: "right" | "down") => handleSplitPane(singleProcess.pane_id, direction)}
            onZoomPane={() => split.toggleZoomLeaf("")}
            onInjectSecrets={() => setInjectSecretsPaneId(singleProcess.pane_id)}
            onSearchSkills={() => setSkillSearchPaneId(singleProcess.pane_id)}
            contentStyle={trafficLightInsetStyle}
            titlePath={buildProcessTitlePath(singleProcess)}
            displayNameOverride={processRenameDrafts[singleProcess.pane_id] ?? null}
          />
        );
      }
      if (!singleShell) return null;
      return (
        <TmuxPaneDetail
          target={{ kind: "shell", shell: singleShell }}
          onBack={() => setViewingShell(null)}
          showBackButton={!isWide}
          hidePath
          onStopped={() => {
            demotedShellPaneIdsRef.current.delete(singleShell.pane_id);
            setShellPanes((prev) => prev.filter((p) => p.pane_id !== singleShell.pane_id));
            selectAdjacentItem(singleShell.pane_id);
          }}
          onSplitPane={(direction: "right" | "down") => handleSplitPane(singleShell.pane_id, direction)}
          onZoomPane={() => split.toggleZoomLeaf("")}
          contentStyle={trafficLightInsetStyle}
          titlePath={shortenPath(singleShell.cwd)}
        />
      );
    }

    if (content.kind === "job") {
      const singleJob = (core.jobs as Job[]).find((j) => j.slug === content.slug);
      if (!singleJob) {
        return (
          <div style={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}>Job not found</span>
          </div>
        );
      }
      const jobQuestion = questions.find((q) => q.matched_job === singleJob.slug);
      const matchedProcess = core.processes.find((p) => p.matched_job === singleJob.slug);
      return (
        <DesktopJobDetail
          transport={transport} job={singleJob}
          status={core.statuses[singleJob.slug] ?? { state: "idle" as const }}
          firstQuery={matchedProcess?.first_query ?? undefined}
          lastQuery={matchedProcess?.last_query ?? undefined}
          onBack={() => setViewingJob(null)}
          onEdit={() => { setEditingJob(singleJob); setViewingJob(null); }}
          onOpen={() => handleOpen(singleJob.slug)}
          onToggle={() => { actions.toggleJob(singleJob.slug); core.reload(); }}
          onDuplicate={(group: string) => handleDuplicate(singleJob, group)}
          onDuplicateToFolder={() => handleDuplicateToFolder(singleJob)}
          onDelete={() => { const slug = singleJob.slug; selectAdjacentItem(slug); actions.deleteJob(slug); core.reload(); }}
          groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
          showBackButton={!isWide} hidePath
          options={jobQuestion?.options}
          questionContext={jobQuestion?.context_lines}
          {...buildJobPaneActions(singleJob, jobQuestion)}
          onStopping={() => {
            setStoppingJobSlugs((prev) => new Set(prev).add(singleJob.slug));
            core.requestFastPoll(`job:${singleJob.slug}`);
          }}
          contentStyle={trafficLightInsetStyle}
          titlePath={buildJobTitlePath(singleJob, jobQuestion)}
          defaultAgentProvider={defaultProvider}
        />
      );
    }

    return (
      <EmptyDetailAgent
        onRunAgent={handleRunAgent}
        getAgentProviders={handleGetAgentProviders}
        defaultProvider={defaultProvider}
        defaultModel={defaultModel}
        enabledModels={enabledModels}
        focusSignal={focusEmptyAgentSignal}
        folderGroups={folderRunGroups}
      />
    );
  }, [agentJob, agentProcess, core.statuses, core.jobs, core.processes, questions, autoYes, actions, handleOpen, handleDuplicate, handleDuplicateToFolder, core.reload, handleFork, handleSplitPane, questionPolling, buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath, isWide, trafficLightInsetStyle, pendingProcess, shellPanes, selectAdjacentItem, openRenameProcessDialog, processRenameDrafts, split.toggleZoomLeaf, handleRunAgent, handleGetAgentProviders, defaultProvider, focusEmptyAgentSignal, folderRunGroups, stoppingProcesses, setStoppingProcesses, setStoppingJobSlugs, demotedShellPaneIdsRef, setShellPanes, setPendingAgentWorkDir, setPendingProcess, setViewingJob, setViewingProcess, setViewingShell, setViewingAgent, setEditingJob, setSkillSearchPaneId, setInjectSecretsPaneId, transport]);

  return { renderLeaf, renderSinglePaneContent };
}
