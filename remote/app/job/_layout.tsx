import { Stack } from "expo-router";
import { colors } from "../../src/theme/colors";

export default function JobLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerBackVisible: true,
        headerBackTitle: "Jobs",
      }}
    />
  );
}
