import { useRef, type ReactNode } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { Ionicons } from "@expo/vector-icons"
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect"
import { NavigationContainer, NavigationIndependentTree, DarkTheme } from "expo-router/react-navigation"
import { createNativeStackNavigator } from "expo-router/build/react-navigation/native-stack"
import { MachineNavigationProvider, colors, type MachineModalProps, type MachineOnboardingContent } from "@clawtab/shared"

type Routes = { page: { id: string; title: string } }
let Stack = createNativeStackNavigator<Routes>()

let SheetCloseButton = ({ title, onClose }: { title: string; onClose: () => void }) => {
  let glassAvailable = false
  try { glassAvailable = isGlassEffectAPIAvailable() } catch {}
  return <View style={styles.iconFrame}>
    {glassAvailable && <GlassView pointerEvents="none" glassEffectStyle="regular" colorScheme="dark" style={[StyleSheet.absoluteFill, styles.iconGlass]} />}
    <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`} onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
      <Ionicons name="close" size={22} color={colors.text} />
    </Pressable>
  </View>
}

export let MachineNavigationModal = ({ title, children, overlay, onClose }: MachineModalProps) => {
  let pages = useRef(new Map<string, MachineOnboardingContent>())
  let nextPage = useRef(0)
  let closeButton = () => <SheetCloseButton title={title} onClose={onClose} />
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaProvider>
      <View style={styles.screen}>
        <NavigationIndependentTree>
          <NavigationContainer theme={DarkTheme}>
            <Stack.Navigator screenOptions={{ animation: "slide_from_right", gestureEnabled: true, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerBackButtonDisplayMode: "minimal", contentStyle: styles.screen, headerRight: closeButton }}>
              <Stack.Screen name="page" initialParams={{ id: "root", title }} options={({ route }) => ({ title: route.params.title })}>
                {({ navigation, route }) => {
                  let push = (page: { title: string; content: MachineOnboardingContent }) => {
                    let id = String(++nextPage.current)
                    pages.current.set(id, page.content)
                    navigation.push("page", { id, title: page.title })
                  }
                  let content = route.params.id === "root" ? children : pages.current.get(route.params.id)
                  let body: ReactNode = typeof content === "function" ? content(onClose) : content
                  return <MachineNavigationProvider value={{ push }}>
                    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{body}</ScrollView>
                  </MachineNavigationProvider>
                }}
              </Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        </NavigationIndependentTree>
        {overlay}
      </View>
    </SafeAreaProvider>
  </Modal>
}

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 24 },
  iconFrame: { width: 44, height: 44, borderRadius: 22, overflow: "hidden" },
  iconGlass: { borderRadius: 22 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
})
