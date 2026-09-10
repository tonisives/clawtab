import { useEffect, useState } from "react"
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { openBrowserAsync } from "expo-web-browser"
import { MachinesPanel, RentalsPanel, ConnectMachine, useMachines, colors } from "@clawtab/shared"
import { approveMachinePairing, machineApi, rentalApi } from "../api/client"
import { useAuthStore } from "../store/auth"

let openCheckout = async (url: string) => Platform.OS === "web" ? Linking.openURL(url) : openBrowserAsync(url)

export let MachineSetup = ({ onNavigate }: { onNavigate?: () => void }) => {
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let router = useRouter()
  let machines = useMachines()
  let [ordering, setOrdering] = useState(false)
  let [manage, setManage] = useState(false)
  let [checkout, setCheckout] = useState<{ purchases: boolean; storefront?: string; loading?: boolean }>({ purchases: false, loading: true })
  useEffect(() => {
    if (!authenticated) return
    let active = true
    let resolve = async () => {
      let capabilities = await rentalApi<{ enabled: boolean; ios_storefronts: string[]; android_storefronts: string[] }>("GET", "/rentals/capabilities")
      let storefront: string | undefined
      if (Platform.OS === "ios" || Platform.OS === "android") {
        let iap: typeof import("react-native-iap") = require("react-native-iap")
        storefront = (await iap.getStorefront()).toUpperCase()
      }
      let allowed: string[] = Platform.OS === "ios" ? capabilities.ios_storefronts : capabilities.android_storefronts
      if (active) setCheckout({ purchases: capabilities.enabled && (Platform.OS === "web" || !!storefront && allowed.includes(storefront)), storefront })
    }
    void resolve().catch(() => { if (active) setCheckout({ purchases: false }) })
    return () => { active = false }
  }, [authenticated])
  let signIn = () => { onNavigate?.(); router.push({ pathname: "/login", params: { return_to: "devices" } }) }
  let toggleManage = () => setManage(!manage)
  if (!authenticated) return <View style={styles.intro}>
    <Text style={styles.text}>Sign in to connect your machines and save groups across your ClawTab apps.</Text>
    <Pressable accessibilityRole="button" onPress={signIn} style={styles.button}><Text style={styles.action}>Sign in</Text></Pressable>
  </View>
  return <>
    <RentalsPanel onOrderingChange={setOrdering} api={rentalApi} {...checkout} platform={Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web"} openUrl={openCheckout} />
    {!checkout.purchases && <View style={styles.unavailable}>
      <Text style={styles.unavailableTitle}>Rent a machine</Text>
      <Text style={styles.detail}>{checkout.loading ? "Checking availability…" : "New rentals aren’t available in this app right now."}</Text>
    </View>}
    {!ordering && <View style={styles.connection}><ConnectMachine approvePairing={approveMachinePairing} /></View>}
    {!ordering && machines.machines.length > 0 && <View style={styles.management}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: manage }} onPress={toggleManage} style={styles.button}>
        <Text style={styles.action}>{manage ? "Hide machine settings" : "Manage connected machines"}</Text>
      </Pressable>
      {manage && <MachinesPanel presentation="panel" approvePairing={approveMachinePairing} api={machineApi} />}
    </View>}
  </>
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
  management: { padding: 16, paddingTop: 0, gap: 16 },
})
