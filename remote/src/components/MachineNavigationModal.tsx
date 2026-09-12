import { useRef, type ReactNode } from "react"
import { Modal, Pressable, ScrollView, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { NavigationContainer, NavigationIndependentTree, DarkTheme } from "expo-router/react-navigation"
import { createNativeStackNavigator } from "expo-router/build/react-navigation/native-stack"
import { MachineNavigationProvider, colors, type MachineModalProps, type MachineOnboardingContent } from "@clawtab/shared"

type Routes = { page: { id: string; title: string } }
let Stack = createNativeStackNavigator<Routes>()

export let MachineNavigationModal = ({ title, children, onClose }: MachineModalProps) => {
  let pages = useRef(new Map<string, MachineOnboardingContent>())
  let nextPage = useRef(0)
  let closeButton = () => <Pressable accessibilityRole="button" accessibilityLabel="Close machine setup" onPress={onClose} hitSlop={12} style={styles.close}>
    <Ionicons name="close" size={22} color={colors.text} />
  </Pressable>
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <NavigationIndependentTree>
      <NavigationContainer theme={DarkTheme}>
        <Stack.Navigator screenOptions={{ animation: "slide_from_right", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerBackButtonDisplayMode: "minimal", contentStyle: styles.screen, headerRight: closeButton }}>
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
  </Modal>
}

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 20 },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
})
