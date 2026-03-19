import { Stack, useRouter } from "expo-router";
import { Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../src/theme/colors";

function BackTitle({ title }: { title: string }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/");
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 4, paddingRight: 12 }}
      activeOpacity={0.6}
    >
      <Ionicons name="chevron-back" size={24} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

export default function JobLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerBackVisible: false,
        headerLeftContainerStyle: { paddingLeft: 8 },
        headerRightContainerStyle: { paddingRight: 16 },
      }}
    />
  );
}

export { BackTitle };
