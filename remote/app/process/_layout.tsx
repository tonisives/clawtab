import { Stack, useRouter } from "expo-router";
import { colors } from "../../src/theme/colors";
import { HeaderBackButton } from "../../src/components/HeaderButtons";

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
        headerBackVisible: false,
        headerBackTitle: "",
        headerLeft: () => <HeaderBackButton onPress={handleBack} />,
      }}
    />
  );
}
