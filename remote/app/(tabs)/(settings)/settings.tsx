import { useEffect, useRef } from "react"
import { useRouter } from "expo-router"
import { createNativeStackNavigator } from "expo-router/build/react-navigation/native-stack"
import { NavigationContainer, NavigationIndependentTree, DarkTheme, useIsFocused, useNavigationContainerRef, type NavigationState } from "expo-router/react-navigation"
import { useMachines } from "@clawtab/shared"
import { Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSetupProgress } from "../../../src/hooks/useSetupProgress"
import { DemoOverview } from "../../../src/components/DemoOverview"
import { useAuthStore } from "../../../src/store/auth"
import { useResponsive } from "../../../src/hooks/useResponsive"
import { ApiTokensSection } from "../../../src/components/ApiTokensSection"
import { MachinePageHistoryProvider, MachinePageScreen, type MachinePageParams } from "../../../src/components/MachineNavigation"
import { MachineSetup } from "../../../src/components/MachineSetup"
import { AccountSettings } from "../../../src/components/settings/AccountSettings"
import { SharingSettings } from "../../../src/components/settings/SharingSettings"
import { TerminalSettings } from "../../../src/components/settings/TerminalSettings"
import { UsageSettings } from "../../../src/components/settings/UsageSettings"
import { SettingsBottomInset, SettingsGroup, SettingsPage, SettingsRow, styles } from "../../../src/components/settings/SettingsPage"
import { SettingsNavigation, SettingsVisibility, useSettingsNavigation, type SettingsRoute } from "../../../src/components/settings/navigation"
import { colors } from "../../../src/theme/colors"

type Routes = { [Page in SettingsRoute]: undefined } & { "machine-page": MachinePageParams }
let Stack = createNativeStackNavigator<Routes>()
export let SettingsHome = () => {
  let router = useRouter()
  let relay = useMachines()
  let { complete } = useSetupProgress()
  let unavailable = !relay.connected
  let email = useAuthStore((state) => state.email)
  let navigate = useSettingsNavigation()
  let open = (page: SettingsRoute) => () => navigate(page)
  return <SettingsPage>
    {!complete && <Pressable accessibilityRole="button" accessibilityLabel="About demo mode" onPress={open("setup")} style={homeStyles.demoButton}><Ionicons name="information-circle-outline" size={20} color={colors.warning} /><Text style={homeStyles.demoText}>Demo</Text></Pressable>}
    <SettingsGroup><SettingsRow title="Relay workspace" detail="Run agents with your existing AI subscription" onPress={() => router.push("/workspace")} /></SettingsGroup>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Relay connection</Text>
      <SettingsGroup>
        <View style={homeStyles.relayRow}>
          <View style={homeStyles.relayConnection}>
            <SettingsRow title={relay.connected ? "Connected to relay" : "Connect to relay"} detail={relay.error ?? (relay.connected ? "Online" : "Disconnected")} onPress={open("account")} />
          </View>

        </View>
        <SettingsRow title="Manage machines" detail="Connections, models, and rented boxes" onPress={open("machines")} disabled={unavailable} />
      </SettingsGroup>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Account</Text>
      <SettingsGroup>
        <SettingsRow title="Account & subscription" detail={email ?? "Sign-in and billing"} onPress={open("account")} />
        <SettingsRow title="Shared access" detail="People and group permissions" onPress={open("sharing")} disabled={unavailable} />
      </SettingsGroup>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Models</Text>
      <SettingsGroup>
        <SettingsRow title="Model usage" detail="Usage limits by machine and provider" onPress={open("usage")} disabled={unavailable} />
      </SettingsGroup>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Preferences & integrations</Text>
      <SettingsGroup>
        <SettingsRow title="Terminal" detail="Recent pane cache" onPress={open("terminal")} />
        <SettingsRow title="API tokens" detail="Automations and external triggers" onPress={open("tokens")} disabled={unavailable} />
      </SettingsGroup>
    </View>
  </SettingsPage>
}
let homeStyles = StyleSheet.create({
  relayRow: { flexDirection: "row", alignItems: "center" },
  relayConnection: { flex: 1 },
  demoButton: { minHeight: 44, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 8 },
  demoText: { color: colors.warning, fontSize: 14, fontWeight: "600" },
})
let SetupSettings = () => {
  let router = useRouter()
  return <DemoOverview onConnect={() => router.push("/workspace")} />
}
let MachineSettings = () => <SettingsPage><MachineSetup manage /></SettingsPage>
let TokenSettings = () => <SettingsPage><ApiTokensSection /></SettingsPage>
let pages = {
  setup: { title: "Setup", component: SetupSettings },
  home: { title: "Settings", component: SettingsHome },
  account: { title: "Account & subscription", component: AccountSettings },
  usage: { title: "Model usage", component: UsageSettings },
  machines: { title: "Manage machines", component: MachineSettings },
  sharing: { title: "Shared access", component: SharingSettings },
  terminal: { title: "Terminal", component: TerminalSettings },
  tokens: { title: "API tokens", component: TokenSettings },
}
type SettingsScreenProps = {
  inModal?: boolean
  active?: boolean
  historyBack?: () => void
  restoreState?: { state: NavigationState | undefined }
  onNavigationStateChange?: (state: NavigationState) => void
}
let SettingsScreen = ({ inModal = false, active = true, historyBack, restoreState, onNavigationStateChange }: SettingsScreenProps) => {
  let navigation = useNavigationContainerRef<Routes>()
  let pendingRestore = useRef(restoreState)
  pendingRestore.current = restoreState
  useEffect(() => {
    if (restoreState && navigation.isReady()) navigation.resetRoot(restoreState.state ?? { index: 0, routes: [{ name: "home" }] })
  }, [navigation, restoreState])
  let focused = useIsFocused()
  let { isWide, isSplitView, isIosPadPortrait } = useResponsive()
  let insets = useSafeAreaInsets()
  let bottomInset = isIosPadPortrait && !inModal ? insets.bottom + 72 : 0
  let largeTitle = Platform.OS === "ios" && !inModal && !isWide && !isSplitView && !isIosPadPortrait
  return <SettingsBottomInset.Provider value={bottomInset}><SettingsVisibility.Provider value={focused && active}><MachinePageHistoryProvider onBack={historyBack}><NavigationIndependentTree><NavigationContainer
    ref={navigation}
    theme={DarkTheme}
    onReady={() => {
      if (pendingRestore.current) navigation.resetRoot(pendingRestore.current.state ?? { index: 0, routes: [{ name: "home" }] })
      else onNavigationStateChange?.(navigation.getRootState())
    }}
    onStateChange={(state) => { if (state) onNavigationStateChange?.(state) }}
  >
    <Stack.Navigator screenOptions={{ headerTintColor: colors.text, headerStyle: { backgroundColor: colors.bg }, headerBackButtonDisplayMode: "minimal", ...(historyBack ? { headerLeft: () => null } : {}), headerShadowVisible: false, contentStyle: styles.scrollContainer }}>
      {(Object.keys(pages) as SettingsRoute[]).map((name) => {
        let Page = pages[name].component
        return <Stack.Screen key={name} name={name} options={{ title: pages[name].title, headerShown: name !== "home" || !inModal, headerLargeTitleEnabled: name === "home" && largeTitle, headerStyle: name === "home" && largeTitle ? undefined : { backgroundColor: colors.bg } }}>
          {({ navigation }) => <SettingsNavigation.Provider value={(page) => navigation.navigate(page)}><Page /></SettingsNavigation.Provider>}
        </Stack.Screen>
      })}
      <Stack.Screen name="machine-page" component={MachinePageScreen} options={({ route }) => ({ title: route.params.title })} />
    </Stack.Navigator>
  </NavigationContainer></NavigationIndependentTree></MachinePageHistoryProvider></SettingsVisibility.Provider></SettingsBottomInset.Provider>
}
export default SettingsScreen
