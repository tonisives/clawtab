import { useCallback, useEffect, useRef, useState } from "react"
import { View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native"
import { useJobsStore, useJob, useJobStatus } from "../store/jobs"
import { useRunsStore } from "../store/runs"
import { useNotificationStore } from "../store/notifications"
import { useWsStore } from "../store/ws"
import { JobDetailView, findYesOption, StatusBadge, XtermLog } from "@clawtab/shared"
import type { XtermLogHandle } from "@clawtab/shared"
import { useLogs } from "../hooks/useLogs"
import { usePty } from "../hooks/usePty"
import { createWsTransport } from "../transport/wsTransport"
import { getWsSend, nextId } from "../hooks/useWebSocket"
import { registerRequest } from "../lib/useRequestMap"
import { DEMO_JOBS, DEMO_STATUSES, DEMO_LOGS, DEMO_RUNS, isDemoJob } from "../demo/data"
import { colors, spacing } from "@clawtab/shared"
import type { Transport } from "@clawtab/shared"
import type { RemoteJob, RunRecord } from "@clawtab/shared"

const wsTransport = createWsTransport()

const noop = async () => {}
const demoTransport: Transport = {
  listJobs: async () => ({ jobs: [], statuses: {} }),
  getStatuses: async () => ({}),
  runJob: noop,
  stopJob: noop,
  pauseJob: noop,
  resumeJob: noop,
  toggleJob: noop,
  deleteJob: noop,
  getRunHistory: async () => [],
  getRunDetail: async () => null,
  detectProcesses: async () => [],
  sendInput: noop,
  subscribeLogs: () => () => {},
  runAgent: async () => null,
}

function agentJobFromSlug(slug: string): RemoteJob {
  const folder = slug.replace(/^agent-/, "")
  return {
    name: slug,
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "agent",
    slug,
    work_dir: folder,
  }
}

interface JobDetailPaneProps {
  jobName: string
  isDemo: boolean
  onClose: () => void
}

export function JobDetailPane({ jobName, isDemo: parentIsDemo, onClose }: JobDetailPaneProps) {
  const storeJob = useJob(jobName)
  const isAgent = !storeJob && jobName.startsWith("agent-")
  const isDemo = parentIsDemo || (!storeJob && !isAgent && isDemoJob(jobName))
  const demoJob = isDemo ? DEMO_JOBS.find((j) => j.name === jobName || j.slug === jobName) : undefined
  const job = storeJob ?? (isAgent ? agentJobFromSlug(jobName) : demoJob)
  const slug = job?.slug ?? jobName
  const realStatus = useJobStatus(jobName)
  const status = isDemo ? (DEMO_STATUSES[slug] ?? realStatus) : realStatus
  const { logs } = useLogs(slug)
  const runs = useRunsStore((s) => s.runs[slug]) ?? null
  const [runsLoading, setRunsLoading] = useState(false)
  const connected = useWsStore((s) => s.connected)

  const questions = useNotificationStore((s) => s.questions)
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds)
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes)
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes)
  const answerQuestion = useNotificationStore((s) => s.answerQuestion)
  const jobQuestion = questions.find((q) => q.matched_job === slug)
  const autoYesActive = jobQuestion ? autoYesPaneIds.has(jobQuestion.pane_id) : false

  const loadRuns = useCallback(() => {
    if (isDemo) return
    const send = getWsSend()
    if (!send || !jobName) return
    const id = nextId()
    setRunsLoading(true)
    send({ type: "get_run_history", id, name: slug, limit: 50 })
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(slug, result)
      setRunsLoading(false)
    })
  }, [slug, isDemo, jobName])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  useEffect(() => {
    if (connected && !isDemo) {
      loadRuns()
    }
  }, [connected, isDemo]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleAutoYes = useCallback(() => {
    if (!jobQuestion) return
    if (autoYesPaneIds.has(jobQuestion.pane_id)) {
      disableAutoYes(jobQuestion.pane_id)
      const send = getWsSend()
      if (send) {
        const next = new Set(autoYesPaneIds)
        next.delete(jobQuestion.pane_id)
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
      }
      return
    }
    const title = jobQuestion.matched_job ?? jobQuestion.cwd.replace(/^\/Users\/[^/]+/, "~")
    Alert.alert(
      "Enable auto-yes?",
      `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable",
          style: "destructive",
          onPress: () => {
            enableAutoYes(jobQuestion.pane_id)
            const send = getWsSend()
            if (send) {
              const next = new Set(autoYesPaneIds)
              next.add(jobQuestion.pane_id)
              send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
            }
            const yesOpt = findYesOption(jobQuestion)
            if (yesOpt) {
              const s = getWsSend()
              if (s) s({ type: "send_input", id: nextId(), name: slug, text: yesOpt })
              setTimeout(() => answerQuestion(jobQuestion.question_id), 1500)
            }
          },
        },
      ],
    )
  }, [jobQuestion, autoYesPaneIds, enableAutoYes, disableAutoYes, answerQuestion, slug])

  const loaded = useJobsStore((s) => s.loaded)

  // PTY streaming for running jobs
  const statusPaneId = status?.state === "running" ? (status as any).pane_id ?? "" : ""
  const statusTmuxSession = status?.state === "running" ? (status as any).tmux_session ?? "" : ""
  const termRef = useRef<XtermLogHandle | null>(null)
  const { sendInput, sendResize, connecting: ptyConnecting } = usePty(statusPaneId, statusTmuxSession, termRef)
  const isRunningWithPty = !!statusPaneId && !!statusTmuxSession && !isDemo

  const renderTerminal = useCallback(
    () => (
      <View style={{ flex: 1, minHeight: 0 }}>
        {ptyConnecting && (
          <View style={styles.ptyConnecting}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.ptyConnectingText}>Connecting to terminal...</Text>
          </View>
        )}
        <XtermLog
          ref={termRef}
          onData={sendInput}
          onResize={sendResize}
          interactive
        />
      </View>
    ),
    [sendInput, sendResize, ptyConnecting],
  )

  if (!job) {
    const waiting = !loaded || !connected
    return (
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
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{job.name}</Text>
        <StatusBadge status={status} />
      </View>
      <JobDetailView
        transport={isDemo ? demoTransport : wsTransport}
        job={job}
        status={status}
        logs={isDemo ? (DEMO_LOGS[slug] ?? "") : logs}
        runs={isDemo ? (DEMO_RUNS[slug] ?? []) : runs}
        runsLoading={isDemo ? false : runsLoading}
        onBack={onClose}
        showBackButton={false}
        onReloadRuns={isDemo ? undefined : loadRuns}
        options={isDemo ? undefined : jobQuestion?.options}
        questionContext={isDemo ? undefined : jobQuestion?.context_lines}
        autoYesActive={isDemo ? false : autoYesActive}
        onToggleAutoYes={isDemo ? undefined : (jobQuestion ? handleToggleAutoYes : undefined)}
        renderTerminal={isRunningWithPty ? renderTerminal : undefined}
        hideMessageInput={isRunningWithPty}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
    flex: 1,
    marginRight: spacing.sm,
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
  ptyConnecting: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ptyConnectingText: {
    color: colors.textMuted,
    fontSize: 12,
  },
})
