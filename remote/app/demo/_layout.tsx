import { Stack, useRouter } from "expo-router"
import { Pressable, StyleSheet, Text } from "react-native"
import { colors } from "@clawtab/shared"

let DemoLayout = () => {
  let router = useRouter()
  let exit = () => router.dismissTo("/")
  let exitButton = () => <Pressable accessibilityRole="button" accessibilityLabel="Exit demo" onPress={exit} hitSlop={8}><Text style={styles.exit}>Exit demo</Text></Pressable>
  return <Stack screenOptions={{ headerTintColor: colors.text, headerStyle: styles.header, contentStyle: styles.screen, headerBackButtonDisplayMode: "minimal", headerRight: exitButton }}>
    <Stack.Screen name="index" options={{ title: "Demo", headerBackVisible: false }} />
    <Stack.Screen name="[id]" options={{ title: "Sample details" }} />
  </Stack>
}
export default DemoLayout

let styles = StyleSheet.create({
  header: { backgroundColor: colors.bg },
  screen: { backgroundColor: colors.bg },
  exit: { color: colors.accent, fontSize: 16 },
})
