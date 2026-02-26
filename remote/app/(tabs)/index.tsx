import { useCallback, useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ScrollView,
  Modal,
  ActivityIndicator,
  Dimensions,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { JobCard } from "../../src/components/JobCard"
import { StatusBadge } from "../../src/components/StatusBadge"
import { ContentContainer } from "../../src/components/ContentContainer"
import { NotificationStack } from "../../src/components/NotificationStack"
import { ProcessCard, parseNumberedOptions } from "../../src/components/ProcessCard"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { useNotifications } from "../../src/hooks/useNotifications"
import { useLogs } from "../../src/hooks/useLogs"
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

                      <ProcessCard process={item.process} onScrollTo={() => scrollToCell(key)} />
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
                    <JobCard job={item.job} status={status} />
                    {status.state === "running" && (
                      <InlineJobReply
                        jobName={item.job.name}
                        onScrollTo={() => scrollToCell(key)}
                      />
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

function InlineJobReply({ jobName, onScrollTo }: { jobName: string; onScrollTo?: () => void }) {
  const [text, setText] = useState("")
  const [expanded, setExpanded] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const { logs } = useLogs(jobName)
  const options = parseNumberedOptions(logs)

  const handleSend = (input: string) => {
    const send = getWsSend()
    if (send && input.trim()) {
      send({ type: "send_input", id: nextId(), name: jobName, text: input.trim() })
      setText("")
    }
  }

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && onScrollTo) setTimeout(onScrollTo, 300)
  }

  return (
    <>
      <View style={styles.inlineReply}>
        {expanded && <InlineJobLogs jobName={jobName} onSend={handleSend} />}
        <View style={styles.inlineReplyToggleRow}>
          <TouchableOpacity
            onPress={handleToggle}
            style={styles.inlineReplyToggle}
            activeOpacity={0.6}
          >
            <Text style={styles.inlineReplyToggleText}>
              {expanded ? "Hide logs" : "Show logs & reply"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setFullscreen(true)}
            style={styles.expandBtn}
            hitSlop={8}
            activeOpacity={0.6}
          >
            <Ionicons name="scan-outline" size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
        {!expanded && options.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.optionScroll}
            contentContainerStyle={styles.optionScrollContent}
          >
            {options.map((opt) => (
              <TouchableOpacity
                key={opt.number}
                style={styles.optionBtn}
                onPress={() => handleSend(opt.number)}
                activeOpacity={0.6}
              >
                <Text style={styles.optionBtnText}>
                  {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {!expanded && (
          <View style={styles.inlineReplyInput}>
            <TextInput
              style={styles.inlineReplyTextInput}
              value={text}
              onChangeText={setText}
              placeholder="Reply..."
              placeholderTextColor={colors.textMuted}
              returnKeyType="send"
              onSubmitEditing={() => handleSend(text)}
            />
            <TouchableOpacity
              style={[styles.inlineReplySendBtn, !text.trim() && styles.btnDisabled]}
              onPress={() => handleSend(text)}
              disabled={!text.trim()}
              activeOpacity={0.7}
            >
              <Text style={styles.inlineReplySendText}>Send</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      {fullscreen && (
        <FullscreenJobTerminal
          jobName={jobName}
          title={jobName}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  )
}

function InlineJobLogs({ jobName, onSend }: { jobName: string; onSend: (text: string) => void }) {
  const { logs } = useLogs(jobName)
  const [text, setText] = useState("")
  const [logsExpanded, setLogsExpanded] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const screenH = Dimensions.get("window").height
  const logHeight = logsExpanded ? screenH * 0.6 : Math.round(screenH / 3)
  const options = parseNumberedOptions(logs)

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false })
    }, 50)
    return () => clearTimeout(timer)
  }, [logs])

  const handleSend = (input: string) => {
    onSend(input)
    setText("")
  }

  return (
    <View>
      {logs ? (
        <View>
          <ScrollView
            ref={scrollRef}
            style={[styles.inlineReplyLogs, { maxHeight: logHeight }]}
            nestedScrollEnabled
          >
            <Text style={styles.inlineReplyLogsText} selectable>
              {logs}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={() => setLogsExpanded((v) => !v)}
            style={styles.logsExpandToggle}
            activeOpacity={0.6}
          >
            <Text style={styles.logsExpandToggleText}>{logsExpanded ? "Collapse" : "Expand"}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {options.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.optionScroll}
          contentContainerStyle={styles.optionScrollContent}
        >
          {options.map((opt) => (
            <TouchableOpacity
              key={opt.number}
              style={styles.optionBtn}
              onPress={() => handleSend(opt.number)}
              activeOpacity={0.6}
            >
              <Text style={styles.optionBtnText}>
                {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      <View style={styles.inlineReplyInput}>
        <TextInput
          style={styles.inlineReplyTextInput}
          value={text}
          onChangeText={setText}
          placeholder="Reply..."
          placeholderTextColor={colors.textMuted}
          returnKeyType="send"
          onSubmitEditing={() => handleSend(text)}
        />
        <TouchableOpacity
          style={[styles.inlineReplySendBtn, !text.trim() && styles.btnDisabled]}
          onPress={() => handleSend(text)}
          disabled={!text.trim()}
          activeOpacity={0.7}
        >
          <Text style={styles.inlineReplySendText}>Send</Text>
        </TouchableOpacity>
      </View>
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
            <ProcessCard process={agentProcess} onScrollTo={onScrollTo} />
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

function FullscreenJobTerminal({
  jobName,
  title,
  onClose,
}: {
  jobName: string
  title: string
  onClose: () => void
}) {
  const { logs } = useLogs(jobName)
  const status = useJobsStore((s) => s.statuses[jobName])
  const [inputText, setInputText] = useState("")
  const scrollRef = useRef<ScrollView>(null)
  const options = parseNumberedOptions(logs)
  const isRunning = status?.state === "running" || status?.state === "paused"

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false })
    }, 50)
    return () => clearTimeout(timer)
  }, [logs])

  const handleSend = (text: string) => {
    const send = getWsSend()
    if (send && text.trim()) {
      send({ type: "send_input", id: nextId(), name: jobName, text: text.trim() })
      setInputText("")
    }
  }

  const handleAction = (action: "run_job" | "pause_job" | "resume_job" | "stop_job") => {
    const send = getWsSend()
    if (send) send({ type: action, id: nextId(), name: jobName })
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen">
      <View style={styles.fsContainer}>
        <View style={styles.fsHeader}>
          <TouchableOpacity onPress={onClose} style={styles.fsCloseBtn} activeOpacity={0.6}>
            <Text style={styles.fsCloseBtnText}>Close</Text>
          </TouchableOpacity>
          <Text style={styles.fsTitle} numberOfLines={1}>
            {title}
          </Text>
          {status && <StatusBadge status={status} />}
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.fsLogs}
          contentContainerStyle={styles.fsLogsContent}
        >
          <Text style={styles.fsLogsText} selectable>
            {logs}
          </Text>
        </ScrollView>
        {options.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.fsOptionBar}
            contentContainerStyle={styles.fsOptionBarContent}
          >
            {options.map((opt) => (
              <TouchableOpacity
                key={opt.number}
                style={styles.optionBtn}
                onPress={() => handleSend(opt.number)}
                activeOpacity={0.6}
              >
                <Text style={styles.optionBtnText}>
                  {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {isRunning ? (
          <View style={styles.fsInputRow}>
            <TextInput
              style={styles.fsTextInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Send input..."
              placeholderTextColor={colors.textMuted}
              returnKeyType="send"
              onSubmitEditing={() => handleSend(inputText)}
            />
            <TouchableOpacity
              style={[styles.fsSendBtn, !inputText.trim() && styles.btnDisabled]}
              onPress={() => handleSend(inputText)}
              disabled={!inputText.trim()}
              activeOpacity={0.7}
            >
              <Text style={styles.fsSendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.fsActionRow}>
            {(status?.state === "idle" || status?.state === "success") && (
              <TouchableOpacity
                style={[styles.fsActionBtn, { backgroundColor: colors.accent }]}
                onPress={() => handleAction("run_job")}
                activeOpacity={0.7}
              >
                <Text style={styles.fsActionBtnText}>
                  {status?.state === "success" ? "Run Again" : "Run"}
                </Text>
              </TouchableOpacity>
            )}
            {status?.state === "failed" && (
              <TouchableOpacity
                style={[styles.fsActionBtn, { backgroundColor: colors.accent }]}
                onPress={() => handleAction("run_job")}
                activeOpacity={0.7}
              >
                <Text style={styles.fsActionBtnText}>Restart</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </Modal>
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
  expandBtn: { padding: 4 },
  inlineReply: {
    marginTop: 4,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  inlineReplyToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: spacing.sm,
  },
  inlineReplyToggle: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  inlineReplyToggleText: { color: colors.textMuted, fontSize: 11 },
  inlineReplyLogs: {
    backgroundColor: "#000",
    borderRadius: radius.sm,
    margin: spacing.sm,
    marginBottom: 0,
    padding: spacing.sm,
  },
  logsExpandToggle: { alignSelf: "center", paddingVertical: 2, paddingHorizontal: spacing.sm },
  logsExpandToggleText: { color: colors.textMuted, fontSize: 10 },
  inlineReplyLogsText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontFamily: "monospace",
    lineHeight: 14,
  },
  optionScroll: { maxHeight: 32, marginHorizontal: spacing.sm },
  optionScrollContent: { gap: 6, paddingVertical: 2 },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: { color: colors.accent, fontSize: 11, fontWeight: "500" },
  inlineReplyInput: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    alignItems: "center",
  },
  inlineReplyTextInput: {
    flex: 1,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 12,
  },
  inlineReplySendBtn: {
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  inlineReplySendText: { color: "#fff", fontSize: 12, fontWeight: "600" },
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
  fsContainer: { flex: 1, backgroundColor: colors.bg },
  fsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: 54,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fsCloseBtn: { paddingVertical: 4, paddingHorizontal: spacing.sm },
  fsCloseBtnText: { color: colors.accent, fontSize: 14, fontWeight: "500" },
  fsTitle: { flex: 1, color: colors.text, fontSize: 13, fontFamily: "monospace" },
  fsLogs: { flex: 1, backgroundColor: "#000" },
  fsLogsContent: { padding: spacing.md },
  fsLogsText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: "monospace",
    lineHeight: 18,
  },
  fsOptionBar: { maxHeight: 48, borderTopWidth: 1, borderTopColor: colors.border },
  fsOptionBarContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: "center",
  },
  fsInputRow: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: "center",
  },
  fsTextInput: {
    flex: 1,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 13,
  },
  fsSendBtn: {
    height: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  fsSendBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  fsActionRow: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    justifyContent: "center",
  },
  fsActionBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  fsActionBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
})
