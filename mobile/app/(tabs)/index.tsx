import { useCallback, useState } from "react";
import { FlatList, View, Text, TextInput, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useJobsStore } from "../../src/store/jobs";
import { useWsStore } from "../../src/store/ws";
import { JobCard } from "../../src/components/JobCard";
import { StatusBadge } from "../../src/components/StatusBadge";
import { ContentContainer } from "../../src/components/ContentContainer";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { useResponsive } from "../../src/hooks/useResponsive";
import * as api from "../../src/api/client";
import { alertError, openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";
import type { RemoteJob, JobStatus } from "../../src/types/job";

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

  type ListItem =
    | { kind: "agent" }
    | { kind: "header"; group: string }
    | { kind: "job"; job: RemoteJob };

  const items: ListItem[] = [];

  // Agent section always first
  if (!subscriptionRequired) {
    items.push({ kind: "agent" });
  }

  for (const [group, groupJobs] of grouped) {
    if (grouped.size > 1 || items.length > 1) {
      items.push({ kind: "header", group: group === "default" ? "General" : group });
    }
    for (const job of groupJobs) {
      items.push({ kind: "job", job });
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
              item.kind === "agent" ? "agent" : item.kind === "header" ? `h_${item.group}` : `j_${item.job.name}`
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
              const status = statuses[item.job.name] ?? IDLE_STATUS;
              return <JobCard job={item.job} status={status} />;
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
