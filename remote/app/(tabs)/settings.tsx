import { useEffect, useState, useCallback, useMemo } from "react"
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Image,
  Linking,
} from "react-native"
import { useRouter } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useAuthStore } from "../../src/store/auth"
import { useWsStore } from "../../src/store/ws"
import { useJobsStore } from "../../src/store/jobs"
import { ContentContainer } from "../../src/components/ContentContainer"
import { ApiTokensSection } from "../../src/components/ApiTokensSection"
import { NotificationsMenuButton } from "../../src/components/NotificationsMenuButton"
import { useResponsive } from "../../src/hooks/useResponsive"
import { ShareSection } from "@clawtab/shared"
import * as api from "../../src/api/client"
import { confirm, alertError, openUrl } from "../../src/lib/platform"
import { colors } from "../../src/theme/colors"
import { radius, spacing } from "../../src/theme/spacing"

type SubStatus = api.SubscriptionStatus | null

function MobileHeader() {
  const insets = useSafeAreaInsets()
  const topInset = Math.max(insets.top - 22, 0)

  return (
    <View style={styles.mobileHeaderWrap}>
      <View style={{ height: topInset }} />
      <View style={styles.mobileHeader}>
        <Pressable onPress={() => Linking.openURL("https://clawtab.cc")} style={styles.mobileBrand}>
          <Image source={require("../../assets/clawtab-icon.png")} style={styles.mobileBrandIcon} />
          <Text style={styles.mobileBrandText}>ClawTab</Text>
        </Pressable>
      </View>
    </View>
  )
}

export default function SettingsScreen({ inModal = false }: { inModal?: boolean }) {
  const userId = useAuthStore((s) => s.userId)
  const email = useAuthStore((s) => s.email)
  const logout = useAuthStore((s) => s.logout)
  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const desktopDeviceName = useWsStore((s) => s.desktopDeviceName)
  const { isWide } = useResponsive()
  const insets = useSafeAreaInsets()

  const [sub, setSub] = useState<SubStatus>(null)
  const [subLoading, setSubLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

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
      ])
      if (newSub !== null) setSub(newSub)
    } finally {
      setRefreshing(false)
    }
  }, [fetchShares])

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
        contentContainerStyle={{ flexGrow: 1 }}
        automaticallyAdjustKeyboardInsets
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textMuted}
          />
        }
      >
        {!isWide && !inModal ? <MobileHeader /> : null}
        <ContentContainer>
          <View style={[styles.container, isWide && !inModal && styles.containerWide]}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              {email && (
                <View style={styles.row}>
                  <Text style={styles.label}>Email</Text>
                  <Text style={styles.value} numberOfLines={1}>
                    {email}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Connection</Text>
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

            {!subLoading && sub?.subscribed && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Subscription</Text>
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
                <View style={styles.row}>
                  <ActivityIndicator size="small" color={colors.textMuted} />
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
      {!isWide && !inModal ? (
        <View style={[styles.floatingNotifications, { top: insets.top + 9 }]}>
          <NotificationsMenuButton hideWhenEmpty variant="fluid" />
        </View>
      ) : null}
    </>
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
  mobileHeader: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  mobileHeaderWrap: {
    backgroundColor: colors.bg,
    paddingBottom: spacing.lg,
  },
  mobileBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    transform: [{ translateY: -10 }],
  },
  mobileBrandIcon: {
    width: 32,
    height: 32,
    borderRadius: 7,
  },
  mobileBrandText: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  floatingNotifications: {
    position: "absolute",
    right: 12,
    zIndex: 100,
    elevation: 100,
  },
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
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
  offlineCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    gap: spacing.sm,
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
    borderRadius: radius.sm,
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
    borderRadius: radius.sm,
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
    borderRadius: radius.sm,
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
