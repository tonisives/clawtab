import { useRef, type ReactNode } from "react"
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { Ionicons } from "@expo/vector-icons"
import { NavigationContainer, NavigationIndependentTree, DarkTheme, useIsFocused } from "expo-router/react-navigation"
import { createNativeStackNavigator } from "expo-router/build/react-navigation/native-stack"
import { colors } from "@clawtab/shared"
import { MachineNavigationProvider, type MachineModalProps, type MachineOnboardingContent } from "../../../shared/src/machines/Onboarding"

type PageParams = { id: string; title: string }
type Routes = { root: PageParams; page: PageParams }
let Stack = createNativeStackNavigator<Routes>()
let Presentation = createNativeStackNavigator<{ anchor: undefined; sheet: undefined }>()
let initialState = { index: 1, routes: [{ name: "anchor" }, { name: "sheet" }] }
let SheetAnchor = () => <View />
let SheetOverlay = ({ children }: { children: ReactNode }) => useIsFocused() ? <>{children}</> : null

let SheetCloseButton = ({ title, onClose }: { title: string; onClose: () => void }) => (
  <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`} onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
    <Ionicons name="close" size={22} color={colors.text} />
  </Pressable>
)

export let MachineNavigationModal = ({ title, children, overlay, onClose }: MachineModalProps) => {
  let pages = useRef(new Map<string, MachineOnboardingContent>())
  let nextPage = useRef(0)
  let closeButton = () => <SheetCloseButton title={title} onClose={onClose} />
  let renderPage = ({ navigation, route }: { navigation: { push: (name: "page", params: PageParams) => void }; route: { params: PageParams } }) => {
    let push = (page: { title: string; content: MachineOnboardingContent }) => {
      let id = String(++nextPage.current)
      pages.current.set(id, page.content)
      navigation.push("page", { id, title: page.title })
    }
    let content = route.params.id === "root" ? children : pages.current.get(route.params.id)
    let body: ReactNode = typeof content === "function" ? content(onClose) : content
    return <MachineNavigationProvider value={{ push }}>
      <View style={styles.screen}>
        <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{body}</ScrollView>
        <SheetOverlay>{overlay}</SheetOverlay>
      </View>
    </MachineNavigationProvider>
  }
  let renderSheet = () => <Stack.Navigator screenOptions={{
    gestureEnabled: true,
    headerStyle: styles.header,
    headerTintColor: colors.text,
    headerBackButtonDisplayMode: "minimal",
    contentStyle: styles.screen,
    headerRight: Platform.OS === "ios" ? undefined : closeButton,
    unstable_headerRightItems: Platform.OS === "ios" ? () => [{ type: "button", label: "Close", icon: { type: "sfSymbol", name: "xmark" }, accessibilityLabel: `Close ${title.toLowerCase()}`, onPress: onClose }] : undefined,
  }}>
    <Stack.Screen name="root" initialParams={{ id: "root", title }} options={{ title, headerBackVisible: false }}>{renderPage}</Stack.Screen>
    <Stack.Screen name="page" getId={({ params }) => params.id} options={({ route }) => ({ title: route.params.title })}>{renderPage}</Stack.Screen>
  </Stack.Navigator>
  return <View style={styles.host} pointerEvents="box-none">
    <SafeAreaProvider>
      <NavigationIndependentTree>
        <NavigationContainer theme={DarkTheme} initialState={initialState} onStateChange={(state) => { if (state?.routes[state.index ?? 0]?.name === "anchor") onClose() }}>
          {/* Present with UIKit rather than nesting native screens inside an RN Modal. */}
          <Presentation.Navigator screenOptions={{ headerShown: false, contentStyle: styles.anchor }}>
            <Presentation.Screen name="anchor" component={SheetAnchor} />
            <Presentation.Screen name="sheet" options={{ presentation: "modal" }}>{renderSheet}</Presentation.Screen>
          </Presentation.Navigator>
        </NavigationContainer>
      </NavigationIndependentTree>
    </SafeAreaProvider>
  </View>
}

let styles = StyleSheet.create({
  host: { ...StyleSheet.absoluteFill },
  anchor: { backgroundColor: "transparent" },
  header: { backgroundColor: colors.bg },
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 24 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
})
