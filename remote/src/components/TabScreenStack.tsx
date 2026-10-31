import { Stack, useRouter } from "expo-router";
import { Platform } from "react-native";
import { useResponsive } from "../hooks/useResponsive";
import { colors } from "../theme/colors";
import { NotificationsMenuButton } from "./NotificationsMenuButton";

export function TabScreenStack({ screen, title }: { screen: string; title: string }) {
  const router = useRouter();
  const { isIosPhone, isIosPadPortrait, isSplitView, isWide } = useResponsive();
  const showHeader = Platform.OS !== "web" && !isWide && (isIosPhone || (!isSplitView && !isIosPadPortrait));
  const largeTitle = showHeader && Platform.OS === "ios" && !isSplitView;

  return (
    <Stack
      screenOptions={{
        headerShown: showHeader,
        headerTransparent: false,
        headerLargeTitleEnabled: largeTitle,
        // Opaque large-title backgrounds hide the expanded title on iOS 26.
        // Let the native stack choose its large-title appearance.
        headerStyle: largeTitle ? undefined : { backgroundColor: colors.bg },
        contentStyle: { backgroundColor: colors.bg },
        headerLargeTitleStyle: { color: colors.text, fontWeight: "700" },
        headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: "600" },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        ...(Platform.OS === "ios" ? {
          unstable_headerRightItems: () => [{
            type: "button" as const, label: "Messages",
            icon: { type: "sfSymbol" as const, name: "bell" as const },
            onPress: () => router.push("/notifications"),
          }],
        } : { headerRight: () => <NotificationsMenuButton countOnly /> }),
      }}
    >
      <Stack.Screen name={screen} options={{ title }} />
    </Stack>
  );
}
