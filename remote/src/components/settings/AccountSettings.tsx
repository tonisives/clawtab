import { useEffect, useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import { useResponsive } from "../../hooks/useResponsive"
import * as api from "../../api/client"
import { confirm, alertError, openUrl } from "../../lib/platform"
import { colors } from "../../theme/colors"
import { SettingsPage, SettingsRow, styles } from "./SettingsPage"
import { useSettingsNavigation } from "./navigation"
export let AccountSettings = () => {
  let userId = useAuthStore((s) => s.userId)
  let email = useAuthStore((s) => s.email)
  let logout = useAuthStore((s) => s.logout)
  let { isWide } = useResponsive()
  let [sub, setSub] = useState<api.SubscriptionStatus | null>(null)
  let [subLoading, setSubLoading] = useState(true)
  let [actionLoading, setActionLoading] = useState(false)
  useEffect(() => {
    if (!userId) { setSubLoading(false); return }
    let active = true
    api.getSubscriptionStatus().then((value) => { if (active) setSub(value) }).catch(() => {}).finally(() => { if (active) setSubLoading(false) })
    return () => { active = false }
  }, [userId])
  let handleManageBilling = async () => {
    setActionLoading(true)
    try {
      if (sub?.provider === "apple") {
        await openUrl("https://apps.apple.com/account/subscriptions")
      } else {
        let { url } = await api.createPortal()
        await openUrl(url)
      }
      let updated = await api.getSubscriptionStatus()
      setSub(updated)
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(false)
    }
  }
  let [deleteLoading, setDeleteLoading] = useState(false)
  let [dangerExpanded, setDangerExpanded] = useState(false)
  let router = useRouter()
  let navigate = useSettingsNavigation()
  let openMachines = () => navigate("machines")
  let toggleDanger = () => setDangerExpanded((value) => !value)
  let handleLogout = () => {
    confirm("Log out", "Are you sure you want to log out?", async () => {
      await logout()
      router.replace("/login")
    })
  }
  let handleDeleteAccount = () => {
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
  return <SettingsPage>
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
    {subLoading && <ActivityIndicator color={colors.accent} />}
    {!subLoading && sub?.subscribed && (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Subscription</Text>
        <View style={styles.listGroup}>
          <View style={styles.row}>
            <Text style={styles.label}>Status</Text>
            <Text style={[styles.value, { color: colors.success }]}>{sub.relay_included ? "Included with your box" : "Active"}</Text>
          </View>
          {!sub.relay_included && sub.current_period_end && (
            <View style={styles.row}>
              <Text style={styles.label}>Period ends</Text>
              <Text style={styles.value}>
                {new Date(sub.current_period_end).toLocaleDateString()}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.listGroup}><SettingsRow
          title={actionLoading ? "Loading…" : sub.relay_included ? (sub.provider === "apple" ? "Manage existing Apple subscription" : "Manage boxes") : "Manage subscription"}
          onPress={sub.relay_included && sub.provider !== "apple" ? openMachines : handleManageBilling}
          disabled={actionLoading}
        /></View>
      </View>
    )}
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
        onPress={toggleDanger}
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
  </SettingsPage>
}
