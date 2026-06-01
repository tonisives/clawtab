import { Platform } from "react-native";
import { Stack, useRouter } from "expo-router";
import { colors } from "../../src/theme/colors";

export default function ProcessLayout() {
  const router = useRouter();
  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerBackVisible: Platform.OS !== "ios",
        headerBackTitle: "",
        unstable_headerLeftItems: () => [
          {
            type: "button",
            label: "",
            icon: { type: "sfSymbol", name: "chevron.left" },
            onPress: handleBack,
            width: 36,
            identifier: "back",
            accessibilityLabel: "Back",
          },
        ],
      }}
    />
  );
}
