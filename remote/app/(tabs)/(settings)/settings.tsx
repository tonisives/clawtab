import { useEffect, useRef } from "react"
import { useRouter } from "expo-router"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { NavigationContainer, NavigationIndependentTree, DarkTheme, useNavigationContainerRef, type NavigationState } from "@react-navigation/native"
import { useIsFocused } from "expo-router/react-navigation"
import { useMachines } from "@clawtab/shared"
import { Platform, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useAuthStore } from "../../../src/store/auth"
import { useResponsive } from "../../../src/hooks/useResponsive"
import { ApiTokensSection } from "../../../src/components/ApiTokensSection"
import { EmbeddedMachineNavigation, MachinePageHistoryProvider, MachinePageScreen, type MachinePageParams } from "../../../src/components/MachineNavigation"
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
  let unavailable = !relay.connected
  let email = useAuthStore((state) => state.email)
  let navigate = useSettingsNavigation()
  let open = (page: SettingsRoute) => () => navigate(page)
  return <SettingsPage>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Connections</Text>
      <SettingsGroup>
        <SettingsRow title="Relay" detail={relay.error ?? (relay.connected ? "Connected · Subscription and workspace" : "Subscription and workspace")} onPress={() => router.push("/workspace")} />
        <SettingsRow title="Manage machines" detail="Connections, models, and rented boxes" onPress={open("machines")} disabled={unavailable} />
      </SettingsGroup>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Account</Text>
      <SettingsGroup>
        <SettingsRow title="Account" detail={email ?? "Sign-in and account details"} onPress={open("account")} />
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
let MachineSettings = () => <SettingsPage><MachineSetup manage /></SettingsPage>
let TokenSettings = () => <SettingsPage><ApiTokensSection /></SettingsPage>
let pages = {
  home: { title: "Settings", component: SettingsHome },
  account: { title: "Account", component: AccountSettings },
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
      else {
        const state = navigation.getRootState()
        if (state) onNavigationStateChange?.(state)
      }
    }}
    onStateChange={(state) => { if (state) onNavigationStateChange?.(state) }}
  >
    <Stack.Navigator initialRouteName="home" screenOptions={{ headerTintColor: colors.text, headerStyle: { backgroundColor: colors.bg }, headerBackButtonDisplayMode: "minimal", ...(historyBack ? { headerLeft: () => null } : {}), headerShadowVisible: false, contentStyle: styles.scrollContainer }}>
      {(Object.keys(pages) as SettingsRoute[]).map((name) => {
        let Page = pages[name].component
        return <Stack.Screen key={name} name={name} options={{ title: pages[name].title, headerShown: name !== "home" || !inModal, headerLargeTitleEnabled: name === "home" && largeTitle, headerStyle: name === "home" && largeTitle ? undefined : { backgroundColor: colors.bg } }}>
          {({ navigation }) => <EmbeddedMachineNavigation.Provider value={navigation}><SettingsNavigation.Provider value={(page) => navigation.navigate(page)}><Page /></SettingsNavigation.Provider></EmbeddedMachineNavigation.Provider>}
        </Stack.Screen>
      })}
      <Stack.Screen name="machine-page" options={({ route }) => ({ title: route.params.title })}>{({ navigation, route }) => <EmbeddedMachineNavigation.Provider value={{ ...navigation, params: route.params }}><MachinePageScreen /></EmbeddedMachineNavigation.Provider>}</Stack.Screen>
    </Stack.Navigator>
  </NavigationContainer></NavigationIndependentTree></MachinePageHistoryProvider></SettingsVisibility.Provider></SettingsBottomInset.Provider>
}
export default SettingsScreen
