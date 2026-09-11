import { useEffect, useState } from "react"
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { openBrowserAsync } from "expo-web-browser"
import { MachinesPanel, RentalsPanel, ConnectMachine, AddMachineButton, ManageMachinesButton, MachineOnboardingProvider, colors, type MachineOnboardingContent } from "@clawtab/shared"
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

export let MachineSetup = ({ onNavigate, manage = false }: { onNavigate?: () => void; manage?: boolean }) => {
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let router = useRouter()
  let [ordering, setOrdering] = useState(false)
  let [attempt, setAttempt] = useState(0)
  let [loading, setLoading] = useState(true)
  let [checkout, setCheckout] = useState<RentalAvailability>({ purchases: false })
  useEffect(() => {
    if (!authenticated) return
    let active = true
    setLoading(true)
    let resolve = async () => {
      let capabilities = await rentalApi<RentalCapabilities>("GET", "/rentals/capabilities")
      let availability = await resolveRentalAvailability(capabilities, Platform.OS, getStorefront)
      if (active) setCheckout(availability)
    }
    void resolve().catch(() => { if (active) setCheckout({ purchases: false, reason: "connection" }) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [authenticated, attempt])
  let retry = () => setAttempt((value) => value + 1)
  let signIn = () => { onNavigate?.(); router.push({ pathname: "/login", params: { return_to: "machines" } }) }
  if (!authenticated) return <View style={styles.intro}>
    <Text style={styles.text}>Sign in to connect your machines and save groups across your ClawTab apps.</Text>
    <Pressable accessibilityRole="button" onPress={signIn} style={styles.button}><Text style={styles.action}>Sign in</Text></Pressable>
  </View>
  return <MachineOnboardingProvider content={machineOnboardingContent} management={machineManagementContent}>
    {manage && <View style={styles.navigation}><AddMachineButton /></View>}
    <RentalsPanel showExistingRentals={manage} allowNewRentals={!manage} onOrderingChange={setOrdering} api={rentalApi} {...checkout} platform={Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web"} openUrl={openCheckout} />
    {!manage && !checkout.purchases && <View style={styles.unavailable}>
      <Text style={styles.unavailableTitle}>Rent a machine</Text>
      <Text style={styles.detail}>{loading ? "Checking availability…" : rentalAvailabilityMessage(checkout.reason)}</Text>
      {!loading && ["connection", "storefront"].includes(checkout.reason ?? "") && <Pressable accessibilityRole="button" onPress={retry} style={styles.button}><Text style={styles.action}>Try again</Text></Pressable>}
    </View>}
    {!manage && !ordering && <View style={styles.connection}><ConnectMachine approvePairing={approveMachinePairing} /></View>}
    {!manage && !ordering && <View style={styles.navigation}><ManageMachinesButton /></View>}
    {manage && <View style={styles.management}><MachinesPanel presentation="panel" approvePairing={approveMachinePairing} api={machineApi} /></View>}
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
  management: { paddingHorizontal: 16, paddingBottom: 16 },
})
