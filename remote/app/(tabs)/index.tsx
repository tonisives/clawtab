import { useCallback, useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native"
import { useRouter } from "expo-router"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { ContentContainer } from "../../src/components/ContentContainer"
import { NotificationStack } from "../../src/components/NotificationStack"
import { JobListView } from "@clawtab/shared"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { useNotifications } from "../../src/hooks/useNotifications"
import { useResponsive } from "../../src/hooks/useResponsive"
import * as api from "../../src/api/client"
import { alertError, openUrl } from "../../src/lib/platform"
import { colors } from "@clawtab/shared"
import { radius, spacing } from "@clawtab/shared"
import type { RemoteJob } from "@clawtab/shared"
import type { ClaudeProcess } from "@clawtab/shared"

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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const { isWide } = useResponsive()
  const router = useRouter()

  useNotifications()

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
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

  const handleRunAgent = useCallback((prompt: string) => {
    const send = getWsSend()
    if (!send) return
    send({ type: "run_agent", id: nextId(), prompt })
  }, [])

  const handleSelectJob = useCallback((job: RemoteJob) => {
    router.push(`/job/${job.name}`)
  }, [router])

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
  }, [router])

  const bannerContent = (
    <>
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
        desktopOnline ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading jobs...</Text>
          </View>
        ) : (
          <View style={styles.loadingContainer}>
            <Text style={styles.offlineTitle}>Desktop offline</Text>
            <Text style={styles.offlineText}>Your desktop app needs to be running to load jobs.</Text>
          </View>
        )
      )}
      <NotificationStack />
    </>
  )

  return (
    <View style={styles.container}>
      {subscriptionRequired && (
        <ContentContainer wide>
          {bannerContent}
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
        </ContentContainer>
      )}
      {!subscriptionRequired && (
        <ContentContainer wide fill>
          <JobListView
            jobs={jobs}
            statuses={statuses}
            detectedProcesses={detectedProcesses}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            onRefresh={handleRefresh}
            onSelectJob={handleSelectJob}
            onSelectProcess={handleSelectProcess}
            onRunAgent={desktopOnline ? handleRunAgent : undefined}
            headerContent={bannerContent}
            showEmpty={loaded}
            emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
          />
        </ContentContainer>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  loadingContainer: {
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 60,
  },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  offlineTitle: { color: colors.warning, fontSize: 15, fontWeight: "600" as const },
  offlineText: { color: colors.textMuted, fontSize: 13, textAlign: "center" as const },
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
