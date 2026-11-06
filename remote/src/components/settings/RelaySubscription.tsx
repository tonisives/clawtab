import { cachedRelaySubscription, cachedRelayWorkspace, loadRelaySubscription } from "../../lib/relaySubscriptionCache"
import { trackFunnel } from "../../lib/funnel"
import { HostedWorkspacePanel, machineState, reconnectMachines } from "@clawtab/shared"
import { useIap } from "../../hooks/useIap"
import { useEffect, useRef, useState } from "react"
import { AppState, Platform, View, Text, ActivityIndicator, Pressable } from "react-native"
import { useIsFocused } from "expo-router/react-navigation"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import * as api from "../../api/client"
import { alertError, openUrl } from "../../lib/platform"
import { colors } from "../../theme/colors"
import { SettingsButton, SettingsGroup, SettingsRow, styles } from "./SettingsPage"
import { RelayWelcome } from "../RelayWelcome"

export let RelaySubscription = () => {
  let userId = useAuthStore((s) => s.userId)
  let [sub, setSub] = useState<api.SubscriptionStatus | null>(() => cachedRelaySubscription(userId))
  let [subLoading, setSubLoading] = useState(() => !!userId && !cachedRelaySubscription(userId)?.subscribed)
  let [actionLoading, setActionLoading] = useState(false)
  let [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  let [subscriptionCheckFailed, setSubscriptionCheckFailed] = useState(false)
  let focused = useIsFocused()
  let iap = useIap()
  useEffect(() => {
    if (focused && !subLoading && sub && !sub.subscribed) void trackFunnel("upgrade_view")
  }, [focused, subLoading, sub])

  let router = useRouter()
  let openMachines = () => router.push("/machines")
  let [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false)
  let toggleDiagnostics = () => { void iap.refreshDiagnostics(); setDiagnosticsExpanded((value) => !value) }
  let openPrivacy = () => openUrl("https://clawtab.cc/privacy")
  let openTerms = () => openUrl("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
  let subscriptionRequest = useRef(0)
  let refreshSubscription = async () => {
    let revision = ++subscriptionRequest.current
    let updated: api.SubscriptionStatus
    try { updated = await loadRelaySubscription(userId!, true) }
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
    if (Platform.OS === "android") return
    if (actionLoading || iap.purchasing || subLoading || subscriptionCheckFailed || !sub || sub.subscribed) return
    setActionLoading(true)
    setSubscriptionError(null)
    void trackFunnel("checkout_attempt")
    try {
      if (Platform.OS === "ios") {
        let result = await iap.purchase()
        if (result.status === "cancelled") return
        if (result.status !== "purchased") {
          setSubscriptionError(result.message ?? "Purchase was not completed. Try again or restore an existing purchase.")
          return
        }
        void trackFunnel("purchase_confirmed")
        let updated = await refreshSubscription()
        if (updated && !updated.subscribed) {
          setSubscriptionError("Your purchase is still being confirmed. Retry the subscription check in a moment.")
          setSubscriptionCheckFailed(true)
        }
      } else {
        let { url } = await api.createCheckout()
        await openUrl(url)
        void trackFunnel("checkout_opened")
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
    let cached = cachedRelaySubscription(userId)
    setSub(cached)
    setSubscriptionError(null)
    setSubscriptionCheckFailed(false)
    if (!userId) { setSubLoading(false); return }
    setSubLoading(!cached?.subscribed)
    let active = true
    let checking = false
    let refresh = () => {
      if (checking) return Promise.resolve()
      checking = true
      let revision = ++subscriptionRequest.current
      return loadRelaySubscription(userId!, true).then((value) => {
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
      }).finally(() => { checking = false; if (active) setSubLoading(false) })
    }
    void refresh()
    let timer = focused ? setInterval(() => { void refresh() }, 5_000) : undefined
    let listener = AppState.addEventListener("change", (state) => { if (state === "active" && focused) void refresh() })
    return () => { active = false; ++subscriptionRequest.current; listener.remove(); if (timer) clearInterval(timer) }
  }, [userId, iap.activation, focused])
  let handleManageProvider = async (provider: string | null) => {
    if (Platform.OS === "android") return
    setActionLoading(true)
    try {
      if (provider === "apple") {
        if (Platform.OS === "ios") await iap.manageSubscriptions()
        else await openUrl("https://apps.apple.com/account/subscriptions")
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
  let content = <View style={styles.section}>
    {subLoading && <ActivityIndicator color={colors.accent} />}
    {sub?.hosted_workspace_eligible && <HostedWorkspacePanel key={userId} api={api.rentalApi} initialStatus={cachedRelayWorkspace(userId)} autoStart={focused} />}
    {!subLoading && sub?.subscribed && (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Subscription</Text>
        <SettingsGroup>
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
        </SettingsGroup>
        {sub.relay_included && <Text style={styles.usageDescription}>Your box includes relay access. Any separate relay subscription continues on its normal billing schedule until you cancel it.</Text>}
        {Platform.OS !== "android" && ((sub.providers?.length ?? 0) > 1 ? <View style={styles.section}>
          <SettingsButton title="Manage Apple subscription" onPress={manageApple} disabled={actionLoading} />
          <SettingsButton title="Manage Stripe subscription" onPress={manageStripe} disabled={actionLoading} />
        </View> : (!sub.relay_included || sub.provider) && <SettingsButton
          title={actionLoading ? "Loading…" : sub.relay_included ? `Manage existing ${sub.provider === "apple" ? "Apple" : "Stripe"} subscription` : "Manage subscription"}
          onPress={handleManageBilling}
          disabled={actionLoading}
        />)}
      </View>
    )}
    {!subLoading && !sub?.subscribed && <View style={styles.section}>
      {Platform.OS === "android" ? <Text style={styles.usageDescription}>Relay access requires an existing ClawTab subscription.</Text> : <>
        <SettingsButton title={actionLoading || iap.purchasing ? "Please wait…" : Platform.OS === "ios" && iap.loading ? "Loading purchases…" : iap.price ? `Subscribe · ${iap.price} / month` : "Subscribe to Relay"} onPress={handleSubscribe} disabled={!sub || subLoading || subscriptionCheckFailed || actionLoading || iap.purchasing || (Platform.OS === "ios" && !iap.available)} variant="primary" />
        {Platform.OS === "ios" && iap.error && <Text style={styles.usageDescription}>{iap.error}</Text>}
      </>}
    </View>}
    {sub?.subscribed && <SettingsGroup><SettingsRow title={sub.hosted_workspace_eligible ? "Open ClawTab machine" : "Open your connected machines"} detail={sub.hosted_workspace_eligible ? undefined : "Your rented box includes relay access. Use its remote workspace or connect your own machine."} onPress={openMachines} /></SettingsGroup>}
    {Platform.OS === "ios" && !sub?.subscribed && !!iap.error && <View style={styles.section}>
      <SettingsButton title="Retry loading purchases" onPress={iap.retry} disabled={iap.loading || actionLoading || iap.purchasing} />
    </View>}
    {Platform.OS === "ios" && <SettingsButton title="Restore Purchases" onPress={handleRestore} disabled={subLoading || actionLoading || iap.purchasing} />}
    {Platform.OS === "ios" && !!iap.diagnostic && <View style={styles.section}>
      <SettingsButton title={diagnosticsExpanded ? "Hide purchase diagnostics" : "View purchase diagnostics"} onPress={toggleDiagnostics} expanded={diagnosticsExpanded} />
      {diagnosticsExpanded && <Text selectable style={styles.usageDescription}>{iap.diagnostic}</Text>}
    </View>}
    {!!subscriptionError && <Text accessibilityRole="alert" style={styles.usageDescription}>{subscriptionError}</Text>}
    {subscriptionCheckFailed && <SettingsButton title={actionLoading ? "Checking…" : "Retry subscription check"} onPress={handleRefreshSubscription} disabled={subLoading || actionLoading || iap.purchasing} />}
    {Platform.OS === "ios" && <View style={styles.section}>
      {!sub?.subscribed && <Text style={styles.usageDescription}>Relay access renews monthly until canceled. Manage or cancel your subscription in your Apple account settings.</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Pressable accessibilityRole="link" onPress={openTerms} style={{ minHeight: 44, justifyContent: "center" }}><Text style={styles.rowDetail}>Terms of Use</Text></Pressable>
        <Pressable accessibilityRole="link" onPress={openPrivacy} style={{ minHeight: 44, justifyContent: "center" }}><Text style={styles.rowDetail}>Privacy Policy</Text></Pressable>
      </View>
    </View>}
  </View>
  if (subLoading && !sub) return <ActivityIndicator color={colors.accent} />
  return !sub?.hosted_workspace_eligible ? <RelayWelcome>{content}</RelayWelcome> : content
}
