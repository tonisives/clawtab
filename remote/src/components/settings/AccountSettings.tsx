import { machineState, reconnectMachines } from "@clawtab/shared"
import { useIap } from "../../hooks/useIap"
import { useEffect, useRef, useState } from "react"
import { AppState, Platform, View, Text, Pressable, ActivityIndicator } from "react-native"
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
  let [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  let [subscriptionCheckFailed, setSubscriptionCheckFailed] = useState(false)
  let iap = useIap()
  let [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false)
  let toggleDiagnostics = () => setDiagnosticsExpanded((value) => !value)
  let openPrivacy = () => openUrl("https://clawtab.cc/privacy")
  let openTerms = () => openUrl("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
  let subscriptionRequest = useRef(0)
  let refreshSubscription = async () => {
    let revision = ++subscriptionRequest.current
    let updated: api.SubscriptionStatus
    try { updated = await api.getSubscriptionStatus(undefined, userId ?? undefined) }
    catch (error) {
      if (revision !== subscriptionRequest.current || useAuthStore.getState().userId !== userId) return null
      setSubscriptionCheckFailed(true)
      throw error
    }
    if (revision !== subscriptionRequest.current || useAuthStore.getState().userId !== userId) return null
    setSub(updated)
    setSubscriptionError(null)
    setSubscriptionCheckFailed(false)
    if (updated.subscribed && !machineState().connected) reconnectMachines()
    return updated
  }
  let handleRefreshSubscription = async () => {
    setActionLoading(true)
    try { await refreshSubscription() }
    catch { setSubscriptionError("Could not check your subscription. Please try again.") }
    finally { setActionLoading(false) }
  }
  let handleSubscribe = async () => {
    if (actionLoading || iap.purchasing) return
    setActionLoading(true)
    setSubscriptionError(null)
    try {
      if (Platform.OS === "ios") {
        let result = await iap.purchase()
        if (result.status === "cancelled") return
        if (result.status !== "purchased") {
          setSubscriptionError(result.message ?? "Purchase was not completed. Try again or restore an existing purchase.")
          return
        }
        let updated = await refreshSubscription()
        if (updated && !updated.subscribed) {
          setSubscriptionError("Your purchase is still being confirmed. Retry the subscription check in a moment.")
          setSubscriptionCheckFailed(true)
        }
      } else {
        let { url } = await api.createCheckout()
        await openUrl(url)
        await refreshSubscription()
      }
    } catch { setSubscriptionError("Could not complete the subscription. Please try again.") }
    finally { setActionLoading(false) }
  }
  let handleRestore = async () => {
    if (actionLoading || iap.purchasing) return
    setActionLoading(true)
    setSubscriptionError(null)
    setSubscriptionCheckFailed(false)
    try {
      let result = await iap.restore()
      if (result.status === "cancelled") return
      if (result.status !== "purchased") {
        alertError("Restore Purchases", result.message ?? "No subscription was restored. Check the Apple account used for your purchase and try again.")
        return
      }
      let updated = await refreshSubscription()
      if (updated && !updated.subscribed) alertError("Restore Purchases", "No active subscription was found. You can subscribe below.")
    } catch {
      setSubscriptionCheckFailed(false)
      alertError("Restore Purchases", "Could not restore your subscription. Please try again.")
    } finally { setActionLoading(false) }
  }
  useEffect(() => {
    ++subscriptionRequest.current
    setSub(null)
    setSubscriptionError(null)
    setSubscriptionCheckFailed(false)
    if (!userId) { setSubLoading(false); return }
    setSubLoading(true)
    let active = true
    let refresh = () => {
      let revision = ++subscriptionRequest.current
      return api.getSubscriptionStatus(undefined, userId ?? undefined).then((value) => {
        if (!active || revision !== subscriptionRequest.current) return
        setSub(value)
        setSubscriptionError(null)
        setSubscriptionCheckFailed(false)
        if (value.subscribed && !machineState().connected) reconnectMachines()
      }).catch(() => {
        if (active && revision === subscriptionRequest.current) {
          setSubscriptionError("Could not check your subscription. Please try again.")
          setSubscriptionCheckFailed(true)
        }
      }).finally(() => { if (active) setSubLoading(false) })
    }
    void refresh()
    let listener = AppState.addEventListener("change", (state) => { if (state === "active") void refresh() })
    return () => { active = false; ++subscriptionRequest.current; listener.remove() }
  }, [userId, iap.activation])
  let handleManageProvider = async (provider: string | null) => {
    setActionLoading(true)
    try {
      if (provider === "apple") {
        await openUrl("https://apps.apple.com/account/subscriptions")
      } else {
        let { url } = await api.createPortal()
        await openUrl(url)
      }
      await refreshSubscription()
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(false)
    }
  }
  let handleManageBilling = () => handleManageProvider(sub?.provider ?? null)
  let manageApple = () => handleManageProvider("apple")
  let manageStripe = () => handleManageProvider("stripe")
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
          {sub.current_period_end && (!sub.relay_included || sub.provider) && (
            <View style={styles.row}>
              <Text style={styles.label}>{sub.relay_included ? "Separate plan period ends" : "Period ends"}</Text>
              <Text style={styles.value}>
                {new Date(sub.current_period_end).toLocaleDateString()}
              </Text>
            </View>
          )}
        </View>
        {sub.relay_included && <Text style={styles.usageDescription}>Your box includes relay access. Any separate relay subscription continues on its normal billing schedule until you cancel it.</Text>}
        {(sub.providers?.length ?? 0) > 1 ? <View style={styles.listGroup}>
          <SettingsRow title="Manage Apple subscription" onPress={manageApple} disabled={actionLoading} chevron={false} />
          <SettingsRow title="Manage Stripe subscription" onPress={manageStripe} disabled={actionLoading} chevron={false} />
        </View> : (!sub.relay_included || sub.provider) && <View style={styles.listGroup}><SettingsRow
          title={actionLoading ? "Loading…" : sub.relay_included ? `Manage existing ${sub.provider === "apple" ? "Apple" : "Stripe"} subscription` : "Manage subscription"}
          onPress={handleManageBilling}
          disabled={actionLoading}
          chevron={false}
        /></View>}
        {sub.relay_included && <View style={styles.listGroup}><SettingsRow title="Manage boxes" onPress={openMachines} /></View>}
      </View>
    )}
    {!subLoading && !sub?.subscribed && <View style={styles.section}>
      <Text style={styles.sectionTitle}>Relay subscription</Text>
      <View style={styles.listGroup}>
        <SettingsRow title={actionLoading || iap.purchasing ? "Please wait…" : Platform.OS === "ios" && iap.loading ? "Loading purchases…" : iap.price ? `Subscribe · ${iap.price} / month` : "Subscribe"} detail={Platform.OS === "ios" && iap.error ? iap.error : "Connect your machines through the relay"} onPress={handleSubscribe} disabled={!sub || actionLoading || iap.purchasing || (Platform.OS === "ios" && !iap.available)} chevron={false} />
      </View>
    </View>}
    {Platform.OS === "ios" && !sub?.subscribed && !!iap.error && <View style={styles.section}>
      <View style={styles.listGroup}><SettingsRow title="Retry loading purchases" onPress={iap.retry} disabled={iap.loading || actionLoading || iap.purchasing} chevron={false} /></View>
    </View>}
    {Platform.OS === "ios" && <View style={styles.listGroup}>
      <SettingsRow title="Restore Purchases" onPress={handleRestore} disabled={subLoading || actionLoading || iap.purchasing} chevron={false} />
    </View>}
    {Platform.OS === "ios" && !!iap.diagnostic && <View style={styles.section}>
      <View style={styles.listGroup}><SettingsRow title={diagnosticsExpanded ? "Hide purchase diagnostics" : "View purchase diagnostics"} onPress={toggleDiagnostics} chevron={false} /></View>
      {diagnosticsExpanded && <Text selectable style={styles.usageDescription}>{iap.diagnostic}</Text>}
    </View>}
    {!!subscriptionError && <Text accessibilityRole="alert" style={styles.usageDescription}>{subscriptionError}</Text>}
    {subscriptionCheckFailed && <View style={styles.listGroup}><SettingsRow title={actionLoading ? "Checking…" : "Retry subscription check"} onPress={handleRefreshSubscription} disabled={subLoading || actionLoading || iap.purchasing} chevron={false} /></View>}
    {Platform.OS === "ios" && <View style={styles.section}>
      {!sub?.subscribed && <Text style={styles.usageDescription}>Relay access renews monthly until canceled. Manage or cancel your subscription in your Apple account settings.</Text>}
      <View style={styles.listGroup}>
        <SettingsRow title="Terms of Use" onPress={openTerms} chevron={false} />
        <SettingsRow title="Privacy Policy" onPress={openPrivacy} chevron={false} />
      </View>
    </View>}
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
