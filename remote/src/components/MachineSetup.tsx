import { useEffect, useState } from "react"
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { openBrowserAsync } from "expo-web-browser"
import { MachinesPanel, RentalsPanel, colors } from "@clawtab/shared"
import { approveMachinePairing, machineApi, rentalApi } from "../api/client"
import { useAuthStore } from "../store/auth"

let openCheckout = async (url: string) => Platform.OS === "web" ? Linking.openURL(url) : openBrowserAsync(url)

export let MachineSetup = ({ onNavigate }: { onNavigate?: () => void }) => {
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let router = useRouter()
  let [checkout, setCheckout] = useState<{ purchases: boolean; storefront?: string }>({ purchases: false })
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
  if (!authenticated) return <View style={styles.intro}>
    <Text style={styles.text}>Sign in to connect your machines and save groups across your ClawTab apps.</Text>
    <Pressable accessibilityRole="button" onPress={() => { onNavigate?.(); router.push({ pathname: "/login", params: { return_to: "devices" } }) }}><Text style={styles.action}>Sign in</Text></Pressable>
  </View>
  return <>
    <RentalsPanel api={rentalApi} {...checkout} platform={Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web"} openUrl={openCheckout} />
    <MachinesPanel approvePairing={approveMachinePairing} api={machineApi} />
  </>
}

let styles = StyleSheet.create({
  intro: { padding: 20, gap: 16 },
  text: { color: colors.text, fontSize: 14 },
  action: { color: colors.accent, fontSize: 14, paddingVertical: 12 },
})
