import { Stack } from "expo-router";
import { Platform } from "react-native";
import { useResponsive } from "../hooks/useResponsive";
import { colors } from "../theme/colors";
import { NotificationsMenuButton } from "./NotificationsMenuButton";

export function TabScreenStack({ screen, title }: { screen: string; title: string }) {
  const { isIosPadPortrait, isSplitView, isWide } = useResponsive();
  const showHeader = Platform.OS !== "web" && !isWide && !isSplitView && !isIosPadPortrait;
  const largeTitle = showHeader && Platform.OS === "ios";

  return (
    <Stack
      screenOptions={{
        headerShown: showHeader,
        headerLargeTitleEnabled: largeTitle,
        headerTransparent: largeTitle,
        headerStyle: { backgroundColor: largeTitle ? "transparent" : colors.bg },
        headerLargeStyle: { backgroundColor: colors.bg },
        headerLargeTitleStyle: { color: colors.text, fontWeight: "700" },
        headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: "600" },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerRight: () => <NotificationsMenuButton countOnly />,
      }}
    >
      <Stack.Screen name={screen} options={{ title }} />
    </Stack>
  );
}
