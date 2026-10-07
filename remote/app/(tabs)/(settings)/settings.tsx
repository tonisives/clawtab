import { createNativeStackNavigator } from "expo-router/build/react-navigation/native-stack"
import { NavigationContainer, NavigationIndependentTree, DarkTheme, useIsFocused } from "expo-router/react-navigation"
import { Platform, Text, View } from "react-native"
import { useAuthStore } from "../../../src/store/auth"
import { useResponsive } from "../../../src/hooks/useResponsive"
import { ApiTokensSection } from "../../../src/components/ApiTokensSection"
import { MachineSetup } from "../../../src/components/MachineSetup"
import { AccountSettings } from "../../../src/components/settings/AccountSettings"
import { SharingSettings } from "../../../src/components/settings/SharingSettings"
import { TerminalSettings } from "../../../src/components/settings/TerminalSettings"
import { UsageSettings } from "../../../src/components/settings/UsageSettings"
import { SettingsPage, SettingsRow, styles } from "../../../src/components/settings/SettingsPage"
import { SettingsNavigation, SettingsVisibility, useSettingsNavigation, type SettingsRoute } from "../../../src/components/settings/navigation"
import { colors } from "../../../src/theme/colors"

type Routes = { [Page in SettingsRoute]: undefined }
let Stack = createNativeStackNavigator<Routes>()
let SettingsHome = () => {
  let email = useAuthStore((state) => state.email)
  let navigate = useSettingsNavigation()
  let open = (page: SettingsRoute) => () => navigate(page)
  return <SettingsPage>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.listGroup}>
        <SettingsRow title="Account & subscription" detail={email ?? "Sign-in and billing"} onPress={open("account")} />
        <SettingsRow title="Shared access" detail="People and group permissions" onPress={open("sharing")} />
      </View>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Machines & models</Text>
      <View style={styles.listGroup}>
        <SettingsRow title="Model usage" detail="Usage limits by machine and provider" onPress={open("usage")} />
        <SettingsRow title="Manage machines" detail="Connections, models, and rented boxes" onPress={open("machines")} />
      </View>
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Preferences & integrations</Text>
      <View style={styles.listGroup}>
        <SettingsRow title="Terminal" detail="Recent pane cache" onPress={open("terminal")} />
        <SettingsRow title="API tokens" detail="Automations and external triggers" onPress={open("tokens")} />
      </View>
    </View>
  </SettingsPage>
}
let MachineSettings = () => <SettingsPage><MachineSetup manage /></SettingsPage>
let TokenSettings = () => <SettingsPage><ApiTokensSection /></SettingsPage>
let pages = {
  home: { title: "Settings", component: SettingsHome },
  account: { title: "Account & subscription", component: AccountSettings },
  usage: { title: "Model usage", component: UsageSettings },
  machines: { title: "Manage machines", component: MachineSettings },
  sharing: { title: "Shared access", component: SharingSettings },
  terminal: { title: "Terminal", component: TerminalSettings },
  tokens: { title: "API tokens", component: TokenSettings },
}
let SettingsScreen = ({ inModal = false }: { inModal?: boolean }) => {
  let focused = useIsFocused()
  let { isWide, isSplitView, isIosPadPortrait } = useResponsive()
  let largeTitle = Platform.OS === "ios" && !inModal && !isWide && !isSplitView && !isIosPadPortrait
  return <SettingsVisibility.Provider value={focused}><NavigationIndependentTree><NavigationContainer theme={DarkTheme}>
    <Stack.Navigator screenOptions={{ headerTintColor: colors.text, headerStyle: { backgroundColor: colors.bg }, headerBackButtonDisplayMode: "minimal", headerShadowVisible: false, contentStyle: styles.scrollContainer }}>
      {(Object.keys(pages) as SettingsRoute[]).map((name) => {
        let Page = pages[name].component
        return <Stack.Screen key={name} name={name} options={{ title: pages[name].title, headerShown: name !== "home" || !inModal, headerLargeTitleEnabled: name === "home" && largeTitle, headerStyle: name === "home" && largeTitle ? undefined : { backgroundColor: colors.bg } }}>
          {({ navigation }) => <SettingsNavigation.Provider value={(page) => navigation.navigate(page)}><Page /></SettingsNavigation.Provider>}
        </Stack.Screen>
      })}
    </Stack.Navigator>
  </NavigationContainer></NavigationIndependentTree></SettingsVisibility.Provider>
}
export default SettingsScreen
