import { useState } from "react"
import { View, Text, Pressable } from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import { useResponsive } from "../../hooks/useResponsive"
import * as api from "../../api/client"
import { confirm, alertError } from "../../lib/platform"
import { SettingsGroup, SettingsPage, styles } from "./SettingsPage"
import { RelaySubscription } from "./RelaySubscription"

export let AccountSettings = () => {
  let email = useAuthStore((s) => s.email)
  let logout = useAuthStore((s) => s.logout)
  let { isWide } = useResponsive()
  let [deleteLoading, setDeleteLoading] = useState(false)
  let [dangerExpanded, setDangerExpanded] = useState(false)
  let router = useRouter()
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
    <RelaySubscription />
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Session</Text>
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
