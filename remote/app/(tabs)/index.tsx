import { useCallback, useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ScrollView,
  ActivityIndicator,
} from "react-native"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { JobCard } from "../../src/components/JobCard"
import { StatusBadge } from "../../src/components/StatusBadge"
import { ContentContainer } from "../../src/components/ContentContainer"
import { NotificationStack } from "../../src/components/NotificationStack"
import { ProcessCard } from "../../src/components/ProcessCard"
import { RunningJobCard } from "../../src/components/RunningJobCard"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { useNotifications } from "../../src/hooks/useNotifications"
import { useResponsive } from "../../src/hooks/useResponsive"
import * as api from "../../src/api/client"
import { alertError, openUrl } from "../../src/lib/platform"
import { colors } from "../../src/theme/colors"
import { radius, spacing } from "../../src/theme/spacing"
import type { ClaudeProcess, RemoteJob, JobStatus } from "../../src/types/job"

const IDLE_STATUS: JobStatus = { state: "idle" }

const DEMO_JOBS = [
  {
    name: "deploy-backend",
    icon: "B",
    cron: "0 */6 * * *",
    badge: "idle",
    badgeColor: colors.statusIdle,
    badgeBg: "rgba(152, 152, 157, 0.12)",
  },
  {
    name: "db-backup",
    icon: "B",
    cron: "0 2 * * *",
    badge: "success",
    badgeColor: colors.success,
    badgeBg: colors.successBg,
  },
  {
    name: "code-review",
    icon: "C",
    cron: null,
    badge: "running",
    badgeColor: colors.accent,
    badgeBg: colors.accentBg,
  },
  {
    name: "test-suite",
    icon: "F",
    cron: "*/30 * * * *",
    badge: "idle",
    badgeColor: colors.statusIdle,
    badgeBg: "rgba(152, 152, 157, 0.12)",
  },
]

export default function JobsScreen() {
  const jobs = useJobsStore((s) => s.jobs)
  const statuses = useJobsStore((s) => s.statuses)
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses)
  const loaded = useJobsStore((s) => s.loaded)
  const connected = useWsStore((s) => s.connected)
  const subscriptionRequired = useWsStore((s) => s.subscriptionRequired)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const [subLoading, setSubLoading] = useState(false)
  const [agentPrompt, setAgentPrompt] = useState("")
  const [agentSending, setAgentSending] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const { isWide } = useResponsive()

  useNotifications()

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  const scrollRef = useRef<ScrollView>(null)
  const cellOffsets = useRef<Map<string, number>>(new Map())

  const scrollToCell = useCallback((key: string) => {
    const y = cellOffsets.current.get(key)
    if (y != null) {
      scrollRef.current?.scrollTo({ y, animated: true })
    }
  }, [])

  const handleRefresh = useCallback(() => {
    const send = getWsSend()
    if (send) {
      send({ type: "list_jobs", id: nextId() })
    }
  }, [])

  const handleSubscribe = async () => {
    setSubLoading(true)
    try {
      let url: string
      try {
        ;({ url } = await api.createCheckout())
      } catch {
        ;({ url } = await api.getPaymentLink())
      }
      await openUrl(url)
    } catch (e) {
      alertError("Error", String(e))
    } finally {
      setSubLoading(false)
    }
  }

  const handleRunAgent = () => {
    if (!agentPrompt.trim()) return
    const send = getWsSend()
    if (!send) return
    setAgentSending(true)
    send({ type: "run_agent", id: nextId(), prompt: agentPrompt.trim() })
    setAgentPrompt("")
    setAgentSending(false)
  }

  const agentProcess = detectedProcesses.find((p) => p.cwd.endsWith("/clawtab/agent"))
  const agentStatus: JobStatus =
    statuses["agent"] ??
    (agentProcess ? { state: "running", run_id: "", started_at: "" } : IDLE_STATUS)
  const agentState = agentStatus.state
  const canRunAgent = agentState === "idle" || agentState === "success" || agentState === "failed"

  const grouped = new Map<string, RemoteJob[]>()
  for (const job of jobs) {
    const group = job.group || "default"
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group)!.push(job)
  }

  const matchedProcessesByGroup = new Map<string, ClaudeProcess[]>()
  const unmatchedProcesses: ClaudeProcess[] = []
  for (const proc of detectedProcesses) {
    if (proc.matched_group) {
      const list = matchedProcessesByGroup.get(proc.matched_group) ?? []
      list.push(proc)
      matchedProcessesByGroup.set(proc.matched_group, list)
    } else {
      unmatchedProcesses.push(proc)
    }
  }

  type ListItem =
    | { kind: "agent" }
    | { kind: "header"; group: string }
    | { kind: "job"; job: RemoteJob; idx: number }
    | { kind: "process"; process: ClaudeProcess }

  const items: ListItem[] = []

  if (!subscriptionRequired) {
    items.push({ kind: "agent" })
  }

  const hasMultipleGroups = grouped.size > 1 || unmatchedProcesses.length > 0

  for (const [group, groupJobs] of grouped) {
    const displayGroup = group === "default" ? "General" : group
    if (hasMultipleGroups || items.length > 1) {
      items.push({ kind: "header", group: displayGroup })
    }
    if (!collapsedGroups.has(displayGroup)) {
      let jobIdx = 0
      for (const job of groupJobs) {
        items.push({ kind: "job", job, idx: jobIdx++ })
      }
      for (const proc of matchedProcessesByGroup.get(group) ?? []) {
        items.push({ kind: "process", process: proc })
      }
    }
  }

  if (unmatchedProcesses.length > 0) {
    items.push({ kind: "header", group: "Detected" })
    if (!collapsedGroups.has("Detected")) {
      for (const proc of unmatchedProcesses) {
        items.push({ kind: "process", process: proc })
      }
    }
  }

  return (
    <View style={styles.container}>
      <ContentContainer wide>
        {subscriptionRequired && (
          <View style={[styles.subBanner, isWide && styles.subBannerWide]}>
            <Text style={styles.subTitle}>Subscription required</Text>
            <Text style={[styles.subText, isWide && { maxWidth: 400 }]}>
              Subscribe to connect to your desktop and run jobs remotely.
            </Text>
            <TouchableOpacity
              style={[styles.subBtn, subLoading && styles.btnDisabled]}
              onPress={handleSubscribe}
              disabled={subLoading}
              activeOpacity={0.7}
            >
              <Text style={styles.subBtnText}>{subLoading ? "Loading..." : "Subscribe"}</Text>
            </TouchableOpacity>
          </View>
        )}
        {!connected && !subscriptionRequired && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Connecting to relay...</Text>
          </View>
        )}
        {connected && !desktopOnline && jobs.length > 0 && (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerText}>Desktop offline</Text>
          </View>
        )}

        {connected && !loaded && !subscriptionRequired && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading jobs...</Text>
          </View>
        )}

        {subscriptionRequired && (
          <View style={[styles.demoList, { pointerEvents: "none" as const }]}>
            {DEMO_JOBS.map((d, i) => (
              <View key={d.name} style={[styles.demoCard, i > 0 && { marginTop: spacing.sm }]}>
                <View style={styles.demoRow}>
                  <View
                    style={[
                      styles.demoTypeIcon,
                      d.icon === "C" && { backgroundColor: colors.accentBg },
                    ]}
                  >
                    <Text
                      style={[styles.demoTypeIconText, d.icon === "C" && { color: colors.accent }]}
                    >
                      {d.icon}
                    </Text>
                  </View>
                  <View style={styles.demoInfo}>
                    <Text style={styles.demoName}>{d.name}</Text>
                    {d.cron && <Text style={styles.demoMeta}>{d.cron}</Text>}
                  </View>
                  <View style={[styles.demoBadge, { backgroundColor: d.badgeBg }]}>
                    <Text style={[styles.demoBadgeText, { color: d.badgeColor }]}>{d.badge}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ContentContainer>
      {!subscriptionRequired && (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[styles.list, isWide && styles.listWide]}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
            />
          }
        >
          <ContentContainer wide>
            <NotificationStack />
            {items.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No jobs</Text>
                <Text style={styles.emptyText}>
                  {connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
                </Text>
              </View>
            ) : (
              items.map((item, index) => {
                const beforeAgent = item.kind === "agent" && index > 0
                const key =
                  item.kind === "agent"
                    ? "agent"
                    : item.kind === "header"
                      ? `h_${item.group}`
                      : item.kind === "process"
                        ? `p_${item.process.pane_id}`
                        : `j_${item.job.name}`
                const onCellLayout = (e: { nativeEvent: { layout: { y: number } } }) => {
                  cellOffsets.current.set(key, e.nativeEvent.layout.y)
                }
                if (item.kind === "agent") {
                  return (
                    <View
                      key={key}
                      onLayout={onCellLayout}
                      style={{ marginBottom: spacing.md }}
                    >
                      {beforeAgent && <View style={styles.separator} />}
                      <AgentSection
                        agentStatus={agentStatus}
                        agentProcess={agentProcess ?? null}
                        canRunAgent={canRunAgent}
                        agentPrompt={agentPrompt}
                        setAgentPrompt={setAgentPrompt}
                        agentSending={agentSending}
                        handleRunAgent={handleRunAgent}
                        onScrollTo={() => scrollToCell(key)}
                        collapsed={collapsedGroups.has("Agent")}
                        onToggleCollapse={() => toggleGroup("Agent")}
                      />
                    </View>
                  )
                }
                if (item.kind === "header") {
                  const isCollapsed = collapsedGroups.has(item.group)
                  return (
                    <View
                      key={key}
                      onLayout={onCellLayout}
                      style={index > 0 ? { marginTop: spacing.sm } : undefined}
                    >

                      <TouchableOpacity
                        onPress={() => toggleGroup(item.group)}
                        style={styles.groupHeaderRow}
                        activeOpacity={0.6}
                      >
                        <Text style={styles.groupHeaderArrow}>
                          {isCollapsed ? "\u25B6" : "\u25BC"}
                        </Text>
                        <Text style={styles.groupHeader}>{item.group}</Text>
                      </TouchableOpacity>
                    </View>
                  )
                }
                if (item.kind === "process") {
                  return (
                    <View
                      key={key}
                      onLayout={onCellLayout}
                      style={index > 0 ? { marginTop: spacing.sm } : undefined}
                    >

                      <ProcessCard process={item.process} />
                    </View>
                  )
                }
                const status = statuses[item.job.name] ?? IDLE_STATUS
                return (
                  <View
                    key={key}
                    onLayout={onCellLayout}
                    style={[
                      item.idx % 2 === 1 ? { opacity: 0.85 } : undefined,
                      index > 0 ? { marginTop: spacing.sm } : undefined,
                    ]}
                  >
                    {status.state === "running" ? (
                      <RunningJobCard jobName={item.job.name} />
                    ) : (
                      <JobCard job={item.job} status={status} />
                    )}
                  </View>
                )
              })
            )}
          </ContentContainer>
        </ScrollView>
      )}
    </View>
  )
}


function AgentSection({
  agentStatus,
  agentProcess,
  canRunAgent,
  agentPrompt,
  setAgentPrompt,
  agentSending,
  handleRunAgent,
  onScrollTo,
  collapsed,
  onToggleCollapse,
}: {
  agentStatus: JobStatus
  agentProcess: ClaudeProcess | null
  canRunAgent: boolean
  agentPrompt: string
  setAgentPrompt: (v: string) => void
  agentSending: boolean
  handleRunAgent: () => void
  onScrollTo?: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  return (
    <View>
      <TouchableOpacity
        onPress={onToggleCollapse}
        style={styles.groupHeaderRow}
        activeOpacity={0.6}
      >
        <Text style={styles.groupHeaderArrow}>
          {collapsed ? "\u25B6" : "\u25BC"}
        </Text>
        <Text style={styles.groupHeader}>Agent</Text>
        <View style={styles.agentHeaderRight}>
          <StatusBadge status={agentStatus} />
        </View>
      </TouchableOpacity>
      {!collapsed && (
        <>
          {agentProcess ? (
            <ProcessCard process={agentProcess} />
          ) : (
            <View style={styles.agentSection}>
              {canRunAgent && (
                <View style={styles.agentInput}>
                  <TextInput
                    style={styles.agentTextInput}
                    value={agentPrompt}
                    onChangeText={setAgentPrompt}
                    placeholder="Enter a prompt for the agent..."
                    placeholderTextColor={colors.textMuted}
                    returnKeyType="send"
                    onSubmitEditing={handleRunAgent}
                    editable={!agentSending}
                  />
                  <TouchableOpacity
                    style={[
                      styles.agentRunBtn,
                      (!agentPrompt.trim() || agentSending) && styles.btnDisabled,
                    ]}
                    onPress={handleRunAgent}
                    disabled={!agentPrompt.trim() || agentSending}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.agentRunBtnText}>Run</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </>
      )}
    </View>
  )
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 60,
  },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  banner: {
    backgroundColor: colors.surface,
    padding: spacing.sm,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerWarn: { backgroundColor: "#332800" },
  bannerText: { color: colors.textSecondary, fontSize: 12 },
  subBanner: {
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  subBannerWide: { paddingVertical: 48 },
  subTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  subText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },
  subBtn: {
    height: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  subBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  list: { padding: spacing.lg },
  listWide: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xl },
  groupHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  groupHeaderArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  emptyText: { color: colors.textSecondary, fontSize: 14 },
  agentSection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  agentHeaderRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: "auto" },
  agentInput: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  agentTextInput: {
    flex: 1,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 13,
  },
  agentRunBtn: {
    height: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  agentRunBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  demoList: { padding: spacing.lg, opacity: 0.35 },
  demoCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  demoRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  demoTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: "rgba(152, 152, 157, 0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  demoTypeIconText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  demoInfo: { flex: 1, gap: 2 },
  demoName: { color: colors.text, fontSize: 15, fontWeight: "500" },
  demoMeta: { color: colors.textSecondary, fontSize: 12 },
  demoBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 10 },
  demoBadgeText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3 },
})
