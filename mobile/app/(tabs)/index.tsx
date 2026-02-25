import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, View, Text, TextInput, Pressable, StyleSheet, RefreshControl, ScrollView } from "react-native";
import { useJobsStore } from "../../src/store/jobs";
import { useWsStore } from "../../src/store/ws";
import { JobCard } from "../../src/components/JobCard";
import { StatusBadge } from "../../src/components/StatusBadge";
import { ContentContainer } from "../../src/components/ContentContainer";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { useLogs } from "../../src/hooks/useLogs";
import { useResponsive } from "../../src/hooks/useResponsive";
import * as api from "../../src/api/client";
import { alertError, openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";
import type { ClaudeProcess, RemoteJob, JobStatus } from "../../src/types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };

const DEMO_JOBS = [
  { name: "deploy-backend", icon: "B", cron: "0 */6 * * *", badge: "idle", badgeColor: colors.statusIdle, badgeBg: "rgba(152, 152, 157, 0.12)" },
  { name: "db-backup", icon: "B", cron: "0 2 * * *", badge: "success", badgeColor: colors.success, badgeBg: colors.successBg },
  { name: "code-review", icon: "C", cron: null, badge: "running", badgeColor: colors.accent, badgeBg: colors.accentBg },
  { name: "test-suite", icon: "F", cron: "*/30 * * * *", badge: "idle", badgeColor: colors.statusIdle, badgeBg: "rgba(152, 152, 157, 0.12)" },
];

export default function JobsScreen() {
  const jobs = useJobsStore((s) => s.jobs);
  const statuses = useJobsStore((s) => s.statuses);
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses);
  const connected = useWsStore((s) => s.connected);
  const subscriptionRequired = useWsStore((s) => s.subscriptionRequired);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const [subLoading, setSubLoading] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentSending, setAgentSending] = useState(false);
  const { isWide } = useResponsive();

  const handleRefresh = useCallback(() => {
    const send = getWsSend();
    if (send) {
      send({ type: "list_jobs", id: nextId() });
    }
  }, []);

  const handleSubscribe = async () => {
    setSubLoading(true);
    try {
      let url: string;
      try {
        ({ url } = await api.createCheckout());
      } catch {
        ({ url } = await api.getPaymentLink());
      }
      await openUrl(url);
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setSubLoading(false);
    }
  };

  const handleRunAgent = () => {
    if (!agentPrompt.trim()) return;
    const send = getWsSend();
    if (!send) return;
    setAgentSending(true);
    send({ type: "run_agent", id: nextId(), prompt: agentPrompt.trim() });
    setAgentPrompt("");
    setAgentSending(false);
  };

  const agentStatus = statuses["agent"] ?? IDLE_STATUS;
  const agentState = agentStatus.state;
  const canRunAgent = agentState === "idle" || agentState === "success" || agentState === "failed";

  // Group jobs by group, putting agent group first
  const grouped = new Map<string, RemoteJob[]>();
  for (const job of jobs) {
    const group = job.group || "default";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(job);
  }

  // Group detected processes
  const matchedProcessesByGroup = new Map<string, ClaudeProcess[]>();
  const unmatchedProcesses: ClaudeProcess[] = [];
  for (const proc of detectedProcesses) {
    if (proc.matched_group) {
      const list = matchedProcessesByGroup.get(proc.matched_group) ?? [];
      list.push(proc);
      matchedProcessesByGroup.set(proc.matched_group, list);
    } else {
      unmatchedProcesses.push(proc);
    }
  }

  type ListItem =
    | { kind: "agent" }
    | { kind: "header"; group: string }
    | { kind: "job"; job: RemoteJob }
    | { kind: "process"; process: ClaudeProcess };

  const items: ListItem[] = [];

  // Agent section always first
  if (!subscriptionRequired) {
    items.push({ kind: "agent" });
  }

  const hasMultipleGroups = grouped.size > 1 || unmatchedProcesses.length > 0;

  for (const [group, groupJobs] of grouped) {
    if (hasMultipleGroups || items.length > 1) {
      items.push({ kind: "header", group: group === "default" ? "General" : group });
    }
    for (const job of groupJobs) {
      items.push({ kind: "job", job });
    }
    for (const proc of matchedProcessesByGroup.get(group) ?? []) {
      items.push({ kind: "process", process: proc });
    }
  }

  if (unmatchedProcesses.length > 0) {
    items.push({ kind: "header", group: "Detected" });
    for (const proc of unmatchedProcesses) {
      items.push({ kind: "process", process: proc });
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
            <Pressable
              style={[styles.subBtn, subLoading && styles.btnDisabled]}
              onPress={handleSubscribe}
              disabled={subLoading}
            >
              <Text style={styles.subBtnText}>{subLoading ? "Loading..." : "Subscribe"}</Text>
            </Pressable>
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

        {subscriptionRequired ? (
          <View style={[styles.demoList, { pointerEvents: "none" as const }]}>
            {DEMO_JOBS.map((d, i) => (
              <View key={d.name} style={[styles.demoCard, i > 0 && { marginTop: spacing.sm }]}>
                <View style={styles.demoRow}>
                  <View style={[styles.demoTypeIcon, d.icon === "C" && { backgroundColor: colors.accentBg }]}>
                    <Text style={[styles.demoTypeIconText, d.icon === "C" && { color: colors.accent }]}>{d.icon}</Text>
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
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) =>
              item.kind === "agent" ? "agent" : item.kind === "header" ? `h_${item.group}` : item.kind === "process" ? `p_${item.process.pane_id}` : `j_${item.job.name}`
            }
            renderItem={({ item }) => {
              if (item.kind === "agent") {
                return (
                  <View style={styles.agentSection}>
                    <View style={styles.agentHeader}>
                      <Text style={styles.groupHeader}>Agent</Text>
                      <StatusBadge status={agentStatus} />
                    </View>
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
                        <Pressable
                          style={[styles.agentRunBtn, (!agentPrompt.trim() || agentSending) && styles.btnDisabled]}
                          onPress={handleRunAgent}
                          disabled={!agentPrompt.trim() || agentSending}
                        >
                          <Text style={styles.agentRunBtnText}>Run</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              }
              if (item.kind === "header") {
                return (
                  <Text style={styles.groupHeader}>{item.group}</Text>
                );
              }
              if (item.kind === "process") {
                return <ProcessCard process={item.process} />;
              }
              const status = statuses[item.job.name] ?? IDLE_STATUS;
              return (
                <View>
                  <JobCard job={item.job} status={status} />
                  {status.state === "running" && (
                    <InlineJobReply jobName={item.job.name} />
                  )}
                </View>
              );
            }}
            contentContainerStyle={[styles.list, isWide && styles.listWide]}
            ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
            refreshControl={
              <RefreshControl
                refreshing={false}
                onRefresh={handleRefresh}
                tintColor={colors.accent}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No jobs</Text>
                <Text style={styles.emptyText}>
                  {connected
                    ? "No jobs found. Create jobs on your desktop."
                    : "Connecting..."}
                </Text>
              </View>
            }
          />
        )}
      </ContentContainer>
    </View>
  );
}

function parseNumberedOptions(text: string): { number: string; label: string }[] {
  const lines = text.split("\n").slice(-20);
  const options: { number: string; label: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^[\s>›»❯▸▶]*(\d+)\.\s+(.+)/);
    if (match) {
      options.push({ number: match[1], label: match[2].trim() });
    }
  }
  return options;
}

function InlineJobReply({ jobName }: { jobName: string }) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);

  const handleSend = (input: string) => {
    const send = getWsSend();
    if (send && input.trim()) {
      send({ type: "send_input", id: nextId(), name: jobName, text: input.trim() });
      setText("");
    }
  };

  return (
    <View style={styles.inlineReply}>
      {expanded && <InlineJobLogs jobName={jobName} onSend={handleSend} />}
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.inlineReplyToggle}>
        <Text style={styles.inlineReplyToggleText}>{expanded ? "Hide logs" : "Show logs & reply"}</Text>
      </Pressable>
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
          <Pressable
            style={[styles.inlineReplySendBtn, !text.trim() && styles.btnDisabled]}
            onPress={() => handleSend(text)}
            disabled={!text.trim()}
          >
            <Text style={styles.inlineReplySendText}>Send</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function InlineJobLogs({ jobName, onSend }: { jobName: string; onSend: (text: string) => void }) {
  const { logs } = useLogs(jobName);
  const [text, setText] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  const options = parseNumberedOptions(logs);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
    return () => clearTimeout(timer);
  }, [logs]);

  const handleSend = (input: string) => {
    onSend(input);
    setText("");
  };

  return (
    <View>
      {logs ? (
        <ScrollView ref={scrollRef} style={styles.inlineReplyLogs} nestedScrollEnabled>
          <Text style={styles.inlineReplyLogsText} selectable>{logs}</Text>
        </ScrollView>
      ) : null}
      {options.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.optionScroll} contentContainerStyle={styles.optionScrollContent}>
          {options.map((opt) => (
            <Pressable
              key={opt.number}
              style={styles.optionBtn}
              onPress={() => handleSend(opt.number)}
            >
              <Text style={styles.optionBtnText}>
                {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
              </Text>
            </Pressable>
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
        <Pressable
          style={[styles.inlineReplySendBtn, !text.trim() && styles.btnDisabled]}
          onPress={() => handleSend(text)}
          disabled={!text.trim()}
        >
          <Text style={styles.inlineReplySendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ProcessCard({ process }: { process: ClaudeProcess }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = process.cwd.split("/").filter(Boolean).slice(-1)[0] || process.cwd;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.processCard,
        pressed && styles.processCardPressed,
      ]}
      onPress={() => setExpanded((v) => !v)}
    >
      <View style={styles.processRow}>
        <View style={[styles.processTypeIcon]}>
          <Text style={styles.processTypeIconText}>C</Text>
        </View>
        <View style={styles.processInfo}>
          <Text style={styles.processName} numberOfLines={1}>{displayName}</Text>
          <View style={styles.processMeta}>
            <Text style={styles.processMetaText}>v{process.version}</Text>
            <Text style={styles.processMetaText}>detected</Text>
          </View>
        </View>
        <View style={styles.processRunningBadge}>
          <Text style={styles.processRunningText}>running</Text>
        </View>
      </View>
      {expanded && process.log_lines ? (
        <View style={styles.processLogs}>
          <Text style={styles.processLogsText} selectable>{process.log_lines}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  banner: {
    backgroundColor: colors.surface,
    padding: spacing.sm,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerWarn: {
    backgroundColor: "#332800",
  },
  bannerText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  subBanner: {
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  subBannerWide: {
    paddingVertical: 48,
  },
  subTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  subText: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
  },
  subBtn: {
    height: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  subBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  list: {
    padding: spacing.lg,
  },
  listWide: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  groupHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  agentSection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  agentHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  agentInput: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
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
  agentRunBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  processCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.7,
  },
  processCardPressed: {
    backgroundColor: colors.surfaceHover,
  },
  processRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  processTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  processTypeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
    fontStyle: "italic",
  },
  processInfo: {
    flex: 1,
    gap: 2,
  },
  processName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
    fontStyle: "italic",
  },
  processMeta: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  processMetaText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  processRunningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  processRunningText: {
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.3,
    color: colors.accent,
  },
  processLogs: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    backgroundColor: "#000",
    borderRadius: radius.sm,
  },
  processLogsText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
    lineHeight: 16,
  },
  inlineReply: {
    marginTop: 4,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  inlineReplyToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  inlineReplyToggleText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  inlineReplyLogs: {
    maxHeight: 150,
    backgroundColor: "#000",
    borderRadius: radius.sm,
    margin: spacing.sm,
    marginBottom: 0,
    padding: spacing.sm,
  },
  inlineReplyLogsText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontFamily: "monospace",
    lineHeight: 14,
  },
  optionScroll: {
    maxHeight: 36,
    marginHorizontal: spacing.sm,
  },
  optionScrollContent: {
    gap: 4,
    paddingVertical: 2,
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "500",
  },
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
  inlineReplySendText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  demoList: {
    padding: spacing.lg,
    opacity: 0.35,
  },
  demoCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  demoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
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
  demoInfo: {
    flex: 1,
    gap: 2,
  },
  demoName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  demoMeta: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  demoBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
  },
  demoBadgeText: {
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
});
