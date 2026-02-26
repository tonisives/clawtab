import { Stack, useRouter } from "expo-router";
import { Platform, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../src/theme/colors";

function BackButton() {
  const router = useRouter();
  return (
    <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
      <Ionicons name="chevron-back" size={24} color={colors.text} />
    </TouchableOpacity>
  );
}

export default function JobLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerBackVisible: true,
        headerBackTitle: "",
        ...(Platform.OS !== "web" && {
          headerLeft: () => <BackButton />,
        }),
      }}
    />
  );
}
