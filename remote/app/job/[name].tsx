import { ShellSurface } from "../../src/components/ShellSurface";
import { toggleAutoYes } from "../../src/lib/autoYes"
import { useAgentActions } from "../../src/hooks/useAgentActions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View, Text, StyleSheet, Platform } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useJob, useJobStatus, useJobsStore } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { useWsStore } from "../../src/store/ws";
import { JobKindIcon, kindForJob, statusColor } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import type { AgentModelOption, JobUpdate, ProcessProvider } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useLogs } from "../../src/hooks/useLogs";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { registerRequest } from "../../src/lib/useRequestMap";
import { HeaderStatusDot, HeaderTitleWithIcon } from "../../src/components/HeaderButtons";
import { useDetailBack } from "../../src/hooks/useDetailBack";
import { useResponsive } from "../../src/hooks/useResponsive";
import { colors } from "@clawtab/shared";
import { useLandscapeTerminalHeader } from "../../src/hooks/useLandscapeTerminalHeader";
import { TerminalHeaderActions } from "../../src/components/TerminalHeaderActions";
import { LandscapeTerminalBar } from "../../src/components/LandscapeTerminalBar";
import { useLandscapeShellNavigation } from "../../src/hooks/useLandscapeShellNavigation";
import type { RemoteJob, RunRecord } from "@clawtab/shared";
import { buildModelOptions } from "../../src/lib/agentModels";

const AGENT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity", "hermes"];


const wsTransport = createWsTransport();


function agentJobFromSlug(slug: string): RemoteJob {
  const folder = slug.replace(/^agent-/, "");
  return {
    name: slug,
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "agent",
    slug,
    work_dir: folder,
  };
}

export default function JobDetailScreen() {
  const { name, run_id, fromSplit, landscapeHandoff } = useLocalSearchParams<{ name: string; run_id?: string; source?: string; fromSplit?: string; landscapeHandoff?: string }>();
  const insets = useSafeAreaInsets();
  const { isWide } = useResponsive();
  const storeJob = useJob(name);
  const defaultAgentProvider = useJobsStore((s) => s.defaultProvider);
  const defaultAgentModel = useJobsStore((s) => s.defaultModel);
  const enabledModels = useJobsStore((s) => s.enabledModels);
  const isAgent = !storeJob && name.startsWith("agent-");
  const job = storeJob ?? (isAgent ? agentJobFromSlug(name) : undefined);
  const slug = job?.slug ?? name;
  const showLandscapeSidebar = useLandscapeShellNavigation({ kind: "job", slug }, fromSplit === "1" || landscapeHandoff === "1");
  const modelOptions: AgentModelOption[] = buildModelOptions(AGENT_PROVIDERS, enabledModels ?? {});
  const onUpdateJob = useCallback(async (patch: JobUpdate) => {
    if (wsTransport.updateJob) await wsTransport.updateJob(slug, patch);
  }, [slug]);
  const realStatus = useJobStatus(name);
  const status = realStatus;
  const statusPaneId = status?.state === "running" ? (status as any).pane_id ?? "" : "";
  let [showPaneOverview, setShowPaneOverview] = useState(false);
  let agentActionControls = useAgentActions(statusPaneId, showPaneOverview);
  let activeProcess = useJobsStore((state) => state.detectedProcesses.find((process) => process.pane_id === statusPaneId));
  const { logs } = useLogs(slug);
  const runs = useRunsStore((s) => s.runs[slug]) ?? null;
  const goBack = useDetailBack("/(tabs)");
  const [runsLoading, setRunsLoading] = useState(false);
  const connected = useWsStore((s) => s.connected);
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const jobQuestion = questions.find((q) => q.matched_job === slug);
  const autoYesPaneId = jobQuestion?.pane_id ?? statusPaneId;
  const autoYesActive = !!autoYesPaneId && autoYesPaneIds.has(autoYesPaneId);

  const loadRuns = useCallback(() => {
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name: slug, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(slug, result);
      setRunsLoading(false);
    });
  }, [slug]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Reload runs when WebSocket reconnects (e.g. after page refresh)
  useEffect(() => {
    if (connected) {
      loadRuns();
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleAutoYes = useCallback(() => {
    if (!autoYesPaneId) return
    toggleAutoYes(autoYesPaneId, jobQuestion?.matched_job ?? jobQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? slug, () => {
      let yesOpt = jobQuestion ? findYesOption(jobQuestion) : undefined
      let send = getWsSend()
      if (!yesOpt || !send) return
      send({ type: "send_input", id: nextId(), name: slug, text: yesOpt })
      if (jobQuestion) setTimeout(() => answerQuestion(jobQuestion.question_id), 1500)
    })
  }, [autoYesPaneId, jobQuestion, answerQuestion, slug])

  const loaded = useJobsStore((s) => s.loaded);
  const isRunningWithShell = !!statusPaneId;
  const landscapeHeader = useLandscapeTerminalHeader(isRunningWithShell);
  const containerStyle = styles.container;
  const renderTerminal = useCallback(() => <ShellSurface paneId={statusPaneId} onScrollGesture={landscapeHeader.onScrollGesture} />, [statusPaneId, landscapeHeader.onScrollGesture]);
  const loadingHeaderOptions = useMemo(() => ({
    animation: landscapeHandoff === "1" ? "none" as const : "slide_from_right" as const,
    headerShown: !isWide && landscapeHeader.headerShown,
    title: name,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
  }), [isWide, landscapeHeader.headerShown, name, landscapeHandoff]);
  const jobHeaderName = job?.name ?? name;
  const jobHeaderKind = job ? kindForJob(job) : "claude";
  const jobHeaderOptions = useMemo(() => ({
    orientation: Platform.OS === "ios" && !Platform.isPad
      ? isRunningWithShell ? "default" as const : "portrait_up" as const
      : undefined,
    headerShown: !isWide && landscapeHeader.headerShown,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
    headerTitle: () => (
      <HeaderTitleWithIcon
        title={jobHeaderName}
        icon={<JobKindIcon kind={jobHeaderKind} size={26} bare />}
      />
    ),
    headerRight: () => (
      <View style={styles.headerActions}>
        <HeaderStatusDot
          color={autoYesActive ? colors.warning : statusColor(status)}
          onPress={!autoYesPaneId ? undefined : handleToggleAutoYes}
          accessibilityLabel={!autoYesPaneId ? "Status" : autoYesActive ? "Disable auto-yes" : "Enable auto-yes"}
        />
      </View>
    ),
    animation: landscapeHandoff === "1" ? "none" as const : "slide_from_right" as const,
  }), [autoYesActive, autoYesPaneId, handleToggleAutoYes, isWide, landscapeHeader.headerShown, jobHeaderKind, jobHeaderName, status, isRunningWithShell, landscapeHandoff]);
  if (!job) {
    // If jobs haven't loaded yet (cold start from notification), show loading state
    const waiting = !loaded || !connected;
    return (
      <View style={containerStyle}>
        <Stack.Screen options={loadingHeaderOptions} />
        <View style={styles.center}>
          {waiting ? (
            <>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>
                {!connected ? "Connecting..." : "Loading..."}
              </Text>
            </>
          ) : (
            <Text style={styles.notFound}>Job not found</Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Stack.Screen options={jobHeaderOptions} />

      <ContentContainer wide fill>
        <JobDetailView
          transport={wsTransport}
          job={job}
          status={status}
          logs={logs}
          runs={runs}
          runsLoading={runsLoading}
          onBack={goBack}
          showBackButton={false}
          hidePath={isRunningWithShell}
          hideInfoPanels={isRunningWithShell}
          onReloadRuns={loadRuns}
          expandRunId={run_id}
          options={jobQuestion?.options}
          questionContext={isRunningWithShell ? undefined : jobQuestion?.context_lines}
          autoYesActive={autoYesActive}
          onToggleAutoYes={!autoYesPaneId ? undefined : handleToggleAutoYes}
          renderTerminal={isRunningWithShell ? renderTerminal : undefined}
          hideMessageInput={isRunningWithShell}
          expandOutput={isRunningWithShell}
          paneOverview={statusPaneId ? { paneId: statusPaneId, tmuxSession: activeProcess?.tmux_session, windowName: activeProcess?.window_name, cwd: activeProcess?.cwd ?? job.work_dir, startedAt: activeProcess?.session_started_at, firstQuery: activeProcess?.first_query, lastQuery: activeProcess?.last_query } : undefined}
          paneOverviewActions={agentActionControls}
          paneOverviewVisible={showPaneOverview}
          onPaneOverviewVisibleChange={setShowPaneOverview}
          defaultOutputCollapsed
          defaultRunsCollapsed
          defaultAgentProvider={(defaultAgentProvider ?? undefined) as import("@clawtab/shared").ProcessProvider | undefined}
          defaultAgentModel={defaultAgentModel}
          agentModelOptions={modelOptions}
          onUpdateJob={!isAgent ? onUpdateJob : undefined}
          optionBarBottomInset={insets.bottom}
          terminalOptionsOverlay={false}
        />
      </ContentContainer>
      {landscapeHeader.overlayShown ? (
        <LandscapeTerminalBar
          topInset={insets.top}
          leftInset={insets.left}
          rightInset={insets.right}
          onBack={showLandscapeSidebar}
          title={<HeaderTitleWithIcon title={jobHeaderName} icon={<JobKindIcon kind={jobHeaderKind} size={26} bare />} />}
          actions={<TerminalHeaderActions onZoom={showLandscapeSidebar} zoomed onOpenDetails={() => setShowPaneOverview(true)} />}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center" },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  notFound: {
    color: colors.textMuted,
    fontSize: 16,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 8,
  },
});
