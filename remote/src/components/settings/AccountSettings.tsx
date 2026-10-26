import { useState } from "react"
import { View, Text } from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import * as api from "../../api/client"
import { confirm, alertError } from "../../lib/platform"
import { SettingsButton, SettingsGroup, SettingsPage, styles } from "./SettingsPage"
import { RelaySubscription } from "./RelaySubscription"

export let AccountSettings = () => {
  let email = useAuthStore((s) => s.email)
  let logout = useAuthStore((s) => s.logout)
  let [deleteLoading, setDeleteLoading] = useState(false)
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
      <SettingsButton title="Sign out" onPress={handleLogout} disabled={deleteLoading} />
      <SettingsButton title={deleteLoading ? "Deleting..." : "Delete account"} onPress={handleDeleteAccount} disabled={deleteLoading} variant="danger" />
    </View>
    <RelaySubscription />
  </SettingsPage>
}
