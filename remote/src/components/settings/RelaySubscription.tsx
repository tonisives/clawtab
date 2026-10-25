import { HostedWorkspacePanel, machineState, reconnectMachines } from "@clawtab/shared"
import { useIap } from "../../hooks/useIap"
import { useEffect, useRef, useState } from "react"
import { AppState, Platform, View, Text, ActivityIndicator } from "react-native"
import { useRouter } from "expo-router"
import { useAuthStore } from "../../store/auth"
import * as api from "../../api/client"
import { alertError, openUrl } from "../../lib/platform"
import { colors } from "../../theme/colors"
import { SettingsGroup, SettingsRow, styles } from "./SettingsPage"
import { useSettingsNavigation } from "./navigation"
import { RelayWelcome } from "../RelayWelcome"

export let RelaySubscription = ({ onboarding = false }: { onboarding?: boolean }) => {
  let userId = useAuthStore((s) => s.userId)
  let [sub, setSub] = useState<api.SubscriptionStatus | null>(null)
  let [subLoading, setSubLoading] = useState(true)
  let [actionLoading, setActionLoading] = useState(false)
  let [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  let [subscriptionCheckFailed, setSubscriptionCheckFailed] = useState(false)
  let iap = useIap()
  let router = useRouter()
  let navigate = useSettingsNavigation()
  let openMachines = () => navigate("machines")
  let openWorkspace = () => router.push("/workspace")
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
    if (Platform.OS === "android") return
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
    let checking = false
    let refresh = () => {
      if (checking) return Promise.resolve()
      checking = true
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
      }).finally(() => { checking = false; if (active) setSubLoading(false) })
    }
    void refresh()
    let timer = onboarding ? setInterval(() => { void refresh() }, 5_000) : undefined
    let listener = AppState.addEventListener("change", (state) => { if (state === "active") void refresh() })
    return () => { active = false; ++subscriptionRequest.current; listener.remove(); clearInterval(timer) }
  }, [userId, iap.activation, onboarding])
  let handleManageProvider = async (provider: string | null) => {
    if (Platform.OS === "android") return
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
  let content = <View style={styles.section}>
    {subLoading && <ActivityIndicator color={colors.accent} />}
    {!onboarding && !subLoading && sub?.subscribed && (
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
        {Platform.OS !== "android" && ((sub.providers?.length ?? 0) > 1 ? <SettingsGroup>
          <SettingsRow title="Manage Apple subscription" onPress={manageApple} disabled={actionLoading} chevron={false} />
          <SettingsRow title="Manage Stripe subscription" onPress={manageStripe} disabled={actionLoading} chevron={false} />
        </SettingsGroup> : (!sub.relay_included || sub.provider) && <SettingsGroup><SettingsRow
          title={actionLoading ? "Loading…" : sub.relay_included ? `Manage existing ${sub.provider === "apple" ? "Apple" : "Stripe"} subscription` : "Manage subscription"}
          onPress={handleManageBilling}
          disabled={actionLoading}
          chevron={false}
        /></SettingsGroup>)}
        {!onboarding && sub.hosted_workspace_eligible && <SettingsGroup><SettingsRow title="Open Relay workspace" detail="Run two agents with your existing AI subscription" onPress={openWorkspace} /></SettingsGroup>}
        {sub.relay_included && <SettingsGroup><SettingsRow title="Manage boxes" onPress={openMachines} /></SettingsGroup>}
      </View>
    )}
    {!subLoading && !sub?.subscribed && <View style={styles.section}>
      {!onboarding && <Text style={styles.sectionTitle}>Relay subscription</Text>}
      {Platform.OS === "android" ? <Text style={styles.usageDescription}>Relay access requires an existing ClawTab subscription.</Text> : <SettingsGroup>
        <SettingsRow title={actionLoading || iap.purchasing ? "Please wait…" : Platform.OS === "ios" && iap.loading ? "Loading purchases…" : iap.price ? `Subscribe · ${iap.price} / month` : "Subscribe to Relay"} detail={Platform.OS === "ios" && iap.error ? iap.error : onboarding ? undefined : "2 hosted agents and connections for up to 100 on your own machines."} onPress={handleSubscribe} disabled={!sub || actionLoading || iap.purchasing || (Platform.OS === "ios" && !iap.available)} chevron={false} />
      </SettingsGroup>}
    </View>}
    {onboarding && sub?.hosted_workspace_eligible && <HostedWorkspacePanel key={userId} api={api.rentalApi} autoStart />}
    {onboarding && sub?.hosted_workspace_eligible && <SettingsGroup><SettingsRow title="Manage Relay subscription" onPress={() => router.push("/account")} /></SettingsGroup>}
    {onboarding && sub?.subscribed && !sub.hosted_workspace_eligible && <SettingsGroup><SettingsRow title="Open your connected machines" detail="Your rented box includes relay access. Use its remote workspace or connect your own machine." onPress={() => router.push("/machines")} /></SettingsGroup>}
    {Platform.OS === "ios" && !sub?.subscribed && !!iap.error && <View style={styles.section}>
      <SettingsGroup><SettingsRow title="Retry loading purchases" onPress={iap.retry} disabled={iap.loading || actionLoading || iap.purchasing} chevron={false} /></SettingsGroup>
    </View>}
    {Platform.OS === "ios" && <SettingsGroup>
      <SettingsRow title="Restore Purchases" onPress={handleRestore} disabled={subLoading || actionLoading || iap.purchasing} chevron={false} />
    </SettingsGroup>}
    {Platform.OS === "ios" && !!iap.diagnostic && <View style={styles.section}>
      <SettingsGroup><SettingsRow title={diagnosticsExpanded ? "Hide purchase diagnostics" : "View purchase diagnostics"} onPress={toggleDiagnostics} chevron={false} /></SettingsGroup>
      {diagnosticsExpanded && <Text selectable style={styles.usageDescription}>{iap.diagnostic}</Text>}
    </View>}
    {!!subscriptionError && <Text accessibilityRole="alert" style={styles.usageDescription}>{subscriptionError}</Text>}
    {subscriptionCheckFailed && <SettingsGroup><SettingsRow title={actionLoading ? "Checking…" : "Retry subscription check"} onPress={handleRefreshSubscription} disabled={subLoading || actionLoading || iap.purchasing} chevron={false} /></SettingsGroup>}
    {Platform.OS === "ios" && <View style={styles.section}>
      {!sub?.subscribed && <Text style={styles.usageDescription}>Relay access renews monthly until canceled. Manage or cancel your subscription in your Apple account settings.</Text>}
      <SettingsGroup>
        <SettingsRow title="Terms of Use" onPress={openTerms} chevron={false} />
        <SettingsRow title="Privacy Policy" onPress={openPrivacy} chevron={false} />
      </SettingsGroup>
    </View>}
  </View>
  return onboarding && !sub?.hosted_workspace_eligible ? <RelayWelcome>{content}</RelayWelcome> : content
}
