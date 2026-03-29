import { useEffect } from "react";
import { Platform, View, Text } from "react-native";
import { Tabs, useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, Linking } from "react-native";
import { colors } from "../../src/theme/colors";
import { useResponsive } from "../../src/hooks/useResponsive";
import { registerNotificationCategories } from "../../src/lib/notifications";

type IoniconsName = keyof typeof Ionicons.glyphMap;

const tabIcons: Record<string, { focused: IoniconsName; default: IoniconsName }> = {
  Jobs: { focused: "briefcase", default: "briefcase-outline" },
  Settings: { focused: "settings", default: "settings-outline" },
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const icon = tabIcons[label];
  return (
    <Ionicons
      name={focused ? icon.focused : icon.default}
      size={22}
      color={focused ? colors.accent : colors.textMuted}
    />
  );
}

function HeaderBrand() {
  return (
    <Pressable
      onPress={() => Linking.openURL("https://clawtab.cc")}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 12 }}
    >
      <Image
        source={require("../../assets/clawtab-icon.png")}
        style={{ width: 24, height: 24, borderRadius: 5 }}
      />
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "700" }}>ClawTab</Text>
    </Pressable>
  );
}

function HeaderRight() {
  const router = useRouter();
  const pathname = usePathname();
  const isSettings = pathname.includes("settings");

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 12 }}>
      <Pressable
        onPress={() => router.push("/(tabs)/settings")}
        style={{
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: isSettings ? colors.accentBg : "transparent",
        }}
      >
        <Ionicons name={isSettings ? "settings" : "settings-outline"} size={16} color={isSettings ? colors.accent : colors.textMuted} />
      </Pressable>
    </View>
  );
}

function TabsContent({ isWide }: { isWide: boolean }) {
  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerLeft: isWide ? () => <HeaderBrand /> : undefined,
        headerRight: isWide ? () => <HeaderRight /> : () => <HeaderBrand />,
        tabBarStyle: isWide
          ? { display: "none" }
          : {
              backgroundColor: colors.bg,
              borderTopColor: colors.border,
            },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: isWide ? "" : "Jobs",
          tabBarIcon: ({ focused }) => (
            <TabIcon label="Jobs" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="agent"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="connection"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="devices"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: isWide ? "" : "Settings",
          tabBarIcon: ({ focused }) => (
            <TabIcon label="Settings" focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const { isWide } = useResponsive();

  useEffect(() => {
    registerNotificationCategories();
  }, []);

  return <TabsContent isWide={isWide} />;
}
