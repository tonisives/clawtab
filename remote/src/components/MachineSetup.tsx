import { useEffect, useState } from "react"
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { MachineNavigationModal } from "./MachineNavigationModal"
import { useRouter } from "expo-router"
import { openBrowserAsync } from "expo-web-browser"
import { MachinesPanel, RentalsPanel, ConnectMachine, AddMachineButton, ManageMachinesButton, MachineOnboardingProvider, colors, type MachineActionButtonProps, type MachineOnboardingChrome, type MachineOnboardingContent } from "@clawtab/shared"
import { approveMachinePairing, machineApi, rentalApi } from "../api/client"
import { useAuthStore } from "../store/auth"
import { resolveRentalAvailability, rentalAvailabilityMessage, type RentalAvailability, type RentalCapabilities } from "../lib/rentalAvailability"

let openCheckout = async (url: string) => Platform.OS === "web" ? Linking.openURL(url) : openBrowserAsync(url)
let getStorefront = async () => {
  let iap: typeof import("react-native-iap") = require("react-native-iap")
  await iap.initConnection()
  return iap.getStorefront()
}
export let machineOnboardingContent: MachineOnboardingContent = (close) => <MachineSetup onNavigate={close} />
export let machineManagementContent: MachineOnboardingContent = (close) => <MachineSetup manage onNavigate={close} />

let MachineSetupActionButton = ({ label, onPress, accessibilityLabel, disabled, tone, icon, appearance, style }: MachineActionButtonProps) => <Pressable
  accessibilityRole="button"
  accessibilityLabel={accessibilityLabel ?? label}
  disabled={disabled}
  onPress={onPress}
  style={({ pressed }) => [appearance === "settings" ? styles.settingsActionButton : styles.actionButton, tone === "danger" && styles.dangerButton, disabled && styles.disabled, pressed && styles.pressed, style]}
>
  {icon === "back" ? <Ionicons name="chevron-back" size={22} color={colors.text} /> : <Text style={[appearance === "settings" ? styles.settingsActionText : styles.action, tone === "danger" && styles.dangerText]}>{label}</Text>}
  {appearance === "settings" && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />}
</Pressable>

export let machineOnboardingChrome: MachineOnboardingChrome = {
  renderSettingsIcon: () => <Ionicons name="settings-outline" size={20} color={colors.textSecondary} />,
  Modal: Platform.OS === "web" ? undefined : MachineNavigationModal,
  renderActionButton: (props) => <MachineSetupActionButton {...props} />,
}

export let MachineSetup = ({ onNavigate, manage = false }: { onNavigate?: () => void; manage?: boolean }) => {
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let router = useRouter()
  let [ordering, setOrdering] = useState(false)
  let [attempt, setAttempt] = useState(0)
  let [loading, setLoading] = useState(true)
  let [checkout, setCheckout] = useState<RentalAvailability>({ purchases: false })
  let allowNewRentals = !manage && Platform.OS === "web"
  useEffect(() => {
    if (!authenticated || (!manage && !allowNewRentals)) return
    let active = true
    setLoading(true)
    let resolve = async () => {
      let capabilities = await rentalApi<RentalCapabilities>("GET", "/rentals/capabilities")
      let availability = await resolveRentalAvailability(capabilities, Platform.OS, getStorefront)
      if (active) setCheckout(availability)
    }
    void resolve().catch(() => { if (active) setCheckout({ purchases: false, reason: "connection" }) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [authenticated, attempt, manage, allowNewRentals])
  let retry = () => setAttempt((value) => value + 1)
  let signIn = () => { onNavigate?.(); router.push({ pathname: "/login", params: { return_to: "machines" } }) }
  if (!authenticated) return <View style={styles.intro}>
    <Text style={styles.text}>Sign in to connect your machines and save groups across your ClawTab apps.</Text>
    <Pressable accessibilityRole="button" onPress={signIn} style={styles.button}><Text style={styles.action}>Sign in</Text></Pressable>
  </View>
  return <MachineOnboardingProvider content={machineOnboardingContent} management={machineManagementContent} chrome={machineOnboardingChrome}>
    {manage && <View style={styles.navigation}><AddMachineButton /></View>}
    {(manage || allowNewRentals) && <RentalsPanel showExistingRentals={manage} allowNewRentals={allowNewRentals} onOrderingChange={setOrdering} api={rentalApi} {...checkout} platform={Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web"} openUrl={openCheckout}>
      {manage && <MachinesPanel presentation="panel" approvePairing={approveMachinePairing} api={machineApi} />}
    </RentalsPanel>}
    {allowNewRentals && !checkout.purchases && <View style={styles.unavailable}>
      <Text style={styles.unavailableTitle}>Rent a machine</Text>
      <Text style={styles.detail}>{loading ? "Checking availability…" : rentalAvailabilityMessage(checkout.reason)}</Text>
      {!loading && ["connection", "storefront"].includes(checkout.reason ?? "") && <Pressable accessibilityRole="button" onPress={retry} style={styles.button}><Text style={styles.action}>Try again</Text></Pressable>}
    </View>}
    {!manage && !ordering && <View style={styles.connection}><ConnectMachine approvePairing={approveMachinePairing} /></View>}
    {!manage && !ordering && <View style={styles.navigation}><ManageMachinesButton /></View>}
  </MachineOnboardingProvider>
}

let styles = StyleSheet.create({
  intro: { padding: 20, gap: 16 },
  text: { color: colors.text, fontSize: 14 },
  action: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  button: { borderRadius: 999, minHeight: 44, paddingHorizontal: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentBg, borderWidth: 1, borderColor: colors.border },
  unavailable: { margin: 16, marginBottom: 0, gap: 8 },
  unavailableTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  connection: { paddingTop: 16 },
  navigation: { padding: 16 },
  actionButton: { minHeight: 44, paddingHorizontal: 18, borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.45 },
  dangerButton: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  dangerText: { color: colors.danger },
  settingsActionButton: { minHeight: 56, paddingVertical: 16, paddingHorizontal: 18, borderRadius: 24, borderCurve: "continuous", backgroundColor: colors.surface, flexDirection: "row", gap: 12, justifyContent: "space-between", alignItems: "center" },
  settingsActionText: { flexShrink: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
})
