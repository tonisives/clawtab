import { useState } from "react"
import { View, Text, Pressable, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import * as api from "../../api/client"
import { confirm, alertError } from "../../lib/platform"
import { colors } from "../../theme/colors"
import { spacing } from "../../theme/spacing"
import { SettingsButton, SettingsGroup, SettingsPage, styles } from "./SettingsPage"

export let AccountSettings = () => {
  let email = useAuthStore((s) => s.email)
  let logout = useAuthStore((s) => s.logout)
  let [deleteLoading, setDeleteLoading] = useState(false)
  let [dangerExpanded, setDangerExpanded] = useState(false)
  let router = useRouter()
  let handleLogout = () => {
    confirm("Sign out", "Are you sure you want to sign out?", async () => {
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
        <SettingsGroup>
          <View style={styles.row}>
            <Text style={styles.label}>Email</Text>
            <Text style={styles.value} numberOfLines={1}>
              {email}
            </Text>
          </View>
        </SettingsGroup>
      )}
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Session</Text>
      <SettingsButton title="Sign out" onPress={handleLogout} disabled={deleteLoading} />
    </View>
    <View style={accountStyles.divider} />
    <View style={styles.section}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: dangerExpanded }} aria-expanded={dangerExpanded} style={styles.sectionHeadingRow} onPress={() => setDangerExpanded((value) => !value)}>
        <Text style={styles.sectionTitle}>Danger Zone</Text>
        <Text style={accountStyles.dangerToggleText}>{dangerExpanded ? "Hide" : "Show"}</Text>
      </Pressable>
      {dangerExpanded && <SettingsButton title={deleteLoading ? "Deleting..." : "Delete account"} onPress={handleDeleteAccount} disabled={deleteLoading} variant="danger" />}
    </View>
  </SettingsPage>
}

let accountStyles = StyleSheet.create({
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  dangerToggleText: { color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
})
