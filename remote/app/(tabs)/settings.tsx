import { useEffect, useState, useCallback, useMemo } from "react"
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Platform,
} from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../src/store/auth"
import { useWsStore } from "../../src/store/ws"
import { useJobsStore } from "../../src/store/jobs"
import { ContentContainer } from "../../src/components/ContentContainer"
import { ApiTokensSection } from "../../src/components/ApiTokensSection"
import { useResponsive } from "../../src/hooks/useResponsive"
import { ShareSection } from "@clawtab/shared"
import * as api from "../../src/api/client"
import { confirm, alertError, openUrl } from "../../src/lib/platform"
import { colors } from "../../src/theme/colors"
import { radius, spacing } from "../../src/theme/spacing"
import { getWsSend, nextId } from "../../src/lib/wsRuntime"
import { clearRequest, registerRequest } from "../../src/lib/useRequestMap"
import type { ProviderUsageSnapshot, UsageSnapshot } from "../../src/types/messages"
import { UsageProgressBar, parseUsagePercent } from "../../src/components/UsageProgressBar"

type SubStatus = api.SubscriptionStatus | null

export default function SettingsScreen({ inModal = false }: { inModal?: boolean }) {
  const userId = useAuthStore((s) => s.userId)
  const email = useAuthStore((s) => s.email)
  const logout = useAuthStore((s) => s.logout)
  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const desktopDeviceName = useWsStore((s) => s.desktopDeviceName)
  const { isIosPadPortrait, isWide } = useResponsive()

  const [sub, setSub] = useState<SubStatus>(null)
  const [subLoading, setSubLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)

  const [shares, setShares] = useState<api.SharesResponse>({ shared_by_me: [], shared_with_me: [] })
  const [sharesLoading, setSharesLoading] = useState(true)

  const jobs = useJobsStore((s) => s.jobs)
  const availableGroups = useMemo(() => {
    const groups = new Set(jobs.map((j) => j.group || "default"))
    return [...groups].sort()
  }, [jobs])

  const fetchShares = useCallback(async () => {
    try {
      const s = await api.getShares()
      setShares(s)
    } catch (e) {
      console.error("Failed to fetch shares:", e)
    }
  }, [])

  useEffect(() => {
    if (!userId) {
      setSubLoading(false)
      setSharesLoading(false)
      return
    }
    api
      .getSubscriptionStatus()
      .then(setSub)
      .catch(() => setSub(null))
      .finally(() => setSubLoading(false))
    fetchShares().finally(() => setSharesLoading(false))
  }, [userId, fetchShares])

  const fetchUsage = useCallback(async () => {
    if (!desktopOnline) {
      setUsage(null)
      setUsageError(null)
      return
    }
    const send = getWsSend()
    if (!send) return

    const id = nextId()
    setUsageLoading(true)
    setUsageError(null)
    send({ type: "get_usage", id })
    try {
      const response = await Promise.race([
        registerRequest<{ usage?: UsageSnapshot; error?: string; message?: string }>(id),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
      ])
      if (!response?.usage) {
        throw new Error(response?.error ?? response?.message ?? "Usage data is unavailable")
      }
      setUsage(response.usage)
    } catch (e) {
      clearRequest(id)
      setUsageError(e instanceof Error ? e.message : String(e))
    } finally {
      setUsageLoading(false)
    }
  }, [desktopOnline])

  useEffect(() => {
    void fetchUsage()
  }, [fetchUsage])

  const handleManageBilling = async () => {
    setActionLoading(true)
    try {
      if (sub?.provider === "apple") {
        await openUrl("https://apps.apple.com/account/subscriptions")
      } else {
        const { url } = await api.createPortal()
        await openUrl(url)
      }
      const updated = await api.getSubscriptionStatus()
      setSub(updated)
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(false)
    }
  }

  const handleAddShare = useCallback(
    async (email: string) => {
      await api.addShare(email)
      await fetchShares()
    },
    [fetchShares],
  )

  const handleToggleGroup = useCallback(
    async (shareId: string, group: string) => {
      const share = shares.shared_by_me.find((s) => s.id === shareId)
      if (!share) return

      let newGroups: string[] | null
      if (share.allowed_groups === null) {
        newGroups = availableGroups.filter((g) => g !== group)
      } else if (share.allowed_groups.includes(group)) {
        newGroups = share.allowed_groups.filter((g) => g !== group)
        if (newGroups.length === 0) newGroups = null
      } else {
        newGroups = [...share.allowed_groups, group]
        if (availableGroups.every((g) => newGroups!.includes(g))) {
          newGroups = null
        }
      }

      setShares((prev) => ({
        ...prev,
        shared_by_me: prev.shared_by_me.map((s) =>
          s.id === shareId ? { ...s, allowed_groups: newGroups } : s,
        ),
      }))

      try {
        await api.updateShare(shareId, newGroups)
      } catch (e) {
        alertError("Error", e instanceof Error ? e.message : String(e))
        await fetchShares()
      }
    },
    [shares, availableGroups, fetchShares],
  )

  const handleRemoveShare = useCallback(
    (shareId: string, email: string) => {
      confirm("Remove access", `Remove shared access for ${email}?`, async () => {
        try {
          await api.removeShare(shareId)
          await fetchShares()
        } catch (e) {
          alertError("Error", e instanceof Error ? e.message : String(e))
        }
      })
    },
    [fetchShares],
  )

  const [refreshing, setRefreshing] = useState(false)
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [newSub] = await Promise.all([
        api.getSubscriptionStatus().catch(() => null),
        fetchShares(),
        fetchUsage(),
      ])
      if (newSub !== null) setSub(newSub)
    } finally {
      setRefreshing(false)
    }
  }, [fetchShares, fetchUsage])

  const [deleteLoading, setDeleteLoading] = useState(false)
  const [dangerExpanded, setDangerExpanded] = useState(false)
  const router = useRouter()
  const handleLogout = () => {
    confirm("Log out", "Are you sure you want to log out?", async () => {
      await logout()
      router.replace("/login")
    })
  }

  const handleDeleteAccount = () => {
    confirm(
      "Delete Account",
      "This will permanently delete your account and all associated data. This action cannot be undone.",
      () => {
        confirm(
          "Are you sure?",
          "All your devices, shares, subscription, and notification history will be permanently deleted.",
          async () => {
            setDeleteLoading(true)
            try {
              await api.deleteAccount()
              await logout()
              router.replace("/login")
            } catch (e) {
              alertError("Error", e instanceof Error ? e.message : String(e))
            } finally {
              setDeleteLoading(false)
            }
          },
        )
      },
    )
  }

  return (
    <>
      <ScrollView
        style={styles.scrollContainer}
        contentInsetAdjustmentBehavior={inModal ? "never" : "automatic"}
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: isIosPadPortrait && !inModal ? 96 : 0,
        }}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textMuted}
          />
        }
      >
        <ContentContainer>
          <View style={[styles.container, isWide && !inModal && styles.containerWide]}>
            {isIosPadPortrait && !inModal ? (
              <Text style={styles.portraitPageTitle}>Settings</Text>
            ) : null}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              {email && (
                <View style={styles.listGroup}>
                  <View style={styles.row}>
                    <Text style={styles.label}>Email</Text>
                    <Text style={styles.value} numberOfLines={1}>
                      {email}
                    </Text>
                  </View>
                </View>
              )}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Connection</Text>
              <View style={styles.listGroup}>
                <View style={styles.row}>
                  <Text style={styles.label}>Relay</Text>
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: connected ? colors.success : colors.textMuted },
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusText,
                        { color: connected ? colors.success : colors.textMuted },
                      ]}
                    >
                      {connected ? "Connected" : "Connecting..."}
                    </Text>
                  </View>
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Desktop</Text>
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: desktopOnline ? colors.success : colors.textMuted },
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusText,
                        { color: desktopOnline ? colors.success : colors.textMuted },
                      ]}
                      numberOfLines={1}
                    >
                      {desktopOnline ? (desktopDeviceName ?? "Online") : "Offline"}
                    </Text>
                  </View>
                </View>
              </View>
              {!desktopOnline && (
                <View style={styles.offlineCard}>
                  <Text style={styles.offlineTitle}>Desktop not connected</Text>
                  <Text style={styles.offlineText}>
                    Please install ClawTab desktop and sign in to the same account.
                  </Text>
                  <Pressable onPress={() => openUrl("https://clawtab.cc/docs#quick-start")}>
                    <Text style={styles.linkText}>Quick Start Guide</Text>
                  </Pressable>
                  <Pressable onPress={() => openUrl("https://clawtab.cc/docs#deploy")}>
                    <Text style={styles.linkText}>Or use a self-hosted relay server</Text>
                  </Pressable>
                </View>
              )}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeadingRow}>
                <Text style={styles.sectionTitle}>Model Usage</Text>
                <Pressable
                  onPress={() => void fetchUsage()}
                  disabled={usageLoading || !desktopOnline}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh model usage"
                >
                  <Text style={[styles.usageRefresh, (usageLoading || !desktopOnline) && styles.disabledText]}>
                    {usageLoading ? "Refreshing..." : "Refresh"}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.usageDescription}>
                Solid fill shows the elapsed week. The dotted marker shows model usage.
              </Text>
              {!desktopOnline ? (
                <View style={styles.usageEmptyCard}>
                  <Text style={styles.usageEmptyText}>Connect a desktop to load model usage.</Text>
                </View>
              ) : usageLoading && !usage ? (
                <View style={styles.usageEmptyCard}>
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={styles.usageEmptyText}>Loading model usage...</Text>
                </View>
              ) : usage ? (
                <View style={styles.usageCards}>
                  <MobileUsageCard title="Claude" usage={usage.claude} />
                  <MobileUsageCard title="Codex" usage={usage.codex} />
                  <MobileUsageCard title="Antigravity" usage={usage.antigravity} />
                  <MobileUsageCard title="z.ai" usage={usage.zai} />
                </View>
              ) : (
                <View style={styles.usageEmptyCard}>
                  <Text style={styles.usageEmptyText}>
                    {usageError ?? "Usage data is unavailable."}
                  </Text>
                </View>
              )}
            </View>

            {!subLoading && sub?.subscribed && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Subscription</Text>
                <View style={styles.listGroup}>
                  <View style={styles.row}>
                    <Text style={styles.label}>Status</Text>
                    <Text style={[styles.value, { color: colors.success }]}>Active</Text>
                  </View>
                  {sub.current_period_end && (
                    <View style={styles.row}>
                      <Text style={styles.label}>Period ends</Text>
                      <Text style={styles.value}>
                        {new Date(sub.current_period_end).toLocaleDateString()}
                      </Text>
                    </View>
                  )}
                </View>
                <Pressable
                  style={[styles.billingBtn, actionLoading && styles.btnDisabled]}
                  onPress={handleManageBilling}
                  disabled={actionLoading}
                >
                  <Text style={styles.billingBtnText}>
                    {actionLoading ? "Loading..." : "Manage Subscription"}
                  </Text>
                </Pressable>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Shared Access</Text>
              {sharesLoading ? (
                <View style={styles.listGroup}>
                  <View style={styles.row}>
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  </View>
                </View>
              ) : (
                <ShareSection
                  sharedByMe={shares.shared_by_me}
                  sharedWithMe={shares.shared_with_me}
                  availableGroups={availableGroups}
                  loading={sharesLoading}
                  onAdd={handleAddShare}
                  onToggleGroup={handleToggleGroup}
                  onRemove={handleRemoveShare}
                  onLeave={handleRemoveShare}
                />
              )}
            </View>

            <ApiTokensSection />

            <View style={styles.section}>
              <Pressable
                style={[styles.dangerBtn, isWide && styles.btnConstrained]}
                onPress={handleLogout}
              >
                <Text style={styles.dangerText}>Log Out</Text>
              </Pressable>
            </View>

            <View style={styles.divider} />

            <View style={styles.section}>
              <Pressable
                style={styles.dangerHeader}
                onPress={() => setDangerExpanded((value) => !value)}
              >
                <Text style={styles.sectionTitle}>Danger Zone</Text>
                <Text style={styles.dangerToggleText}>{dangerExpanded ? "Hide" : "Show"}</Text>
              </Pressable>
              {dangerExpanded && (
                <Pressable
                  style={[
                    styles.deleteBtn,
                    isWide && styles.btnConstrained,
                    deleteLoading && styles.btnDisabled,
                  ]}
                  onPress={handleDeleteAccount}
                  disabled={deleteLoading}
                >
                  <Text style={styles.deleteBtnText}>
                    {deleteLoading ? "Deleting..." : "Delete Account"}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        </ContentContainer>
      </ScrollView>
    </>
  )
}

function MobileUsageCard({
  title,
  usage,
}: {
  title: string
  usage: ProviderUsageSnapshot
}) {
  const weekEntry = usage.entries.find((entry) => entry.label.toLowerCase() === "week")
  const weekPercent = usage.week_used_percent ?? parseUsagePercent(weekEntry?.value)

  return (
    <View style={styles.usageCard}>
      <View style={styles.usageCardHeader}>
        <Text style={styles.usageCardTitle}>{title}</Text>
        <Text style={styles.usageCardStatus}>{usage.status}</Text>
      </View>
      {weekPercent != null ? (
        <UsageProgressBar usagePercent={weekPercent} />
      ) : (
        <Text style={styles.usageUnavailable}>{usage.summary}</Text>
      )}
      {usage.note ? <Text style={styles.usageNote}>{usage.note}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.xl,
  },
  containerWide: {
    paddingTop: 48,
  },
  portraitPageTitle: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: 0.2,
    marginBottom: spacing.sm,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  listGroup: {
    ...(Platform.OS !== "web"
      ? {
          marginHorizontal: -spacing.md,
          borderRadius: 18,
          overflow: "hidden",
          backgroundColor: colors.surface,
        }
      : {}),
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS !== "web"
      ? {
          borderRadius: 0,
          borderWidth: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
          paddingVertical: spacing.lg,
        }
      : {}),
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusText: {
    fontSize: 14,
    fontWeight: "500",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
    maxWidth: "60%",
  },
  usageRefresh: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  disabledText: {
    color: colors.textMuted,
  },
  usageDescription: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  usageCards: {
    gap: spacing.sm,
  },
  usageCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  usageCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  usageCardTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  usageCardStatus: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  usageUnavailable: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  usageNote: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  usageEmptyCard: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  usageEmptyText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  offlineCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    gap: spacing.sm,
    ...(Platform.OS !== "web"
      ? {
          marginHorizontal: -spacing.md,
          borderRadius: 18,
          borderWidth: 0,
        }
      : {}),
  },
  offlineTitle: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: "600",
  },
  offlineText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  linkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "500",
  },
  billingBtn: {
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  billingBtnText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnConstrained: {
    alignSelf: "flex-start",
    width: 220,
  },
  dangerBtn: {
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.danger,
    justifyContent: "center",
    alignItems: "center",
  },
  dangerText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "600",
  },
  dangerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  dangerToggleText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  deleteBtn: {
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.danger,
    justifyContent: "center",
    alignItems: "center",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  deleteBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
})
