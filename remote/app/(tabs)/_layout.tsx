import { useEffect } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, Linking } from "react-native";
import { colors } from "../../src/theme/colors";
import { useResponsive } from "../../src/hooks/useResponsive";
import { ResizableSidebar } from "../../src/components/ResizableSidebar";
import { registerNotificationCategories } from "../../src/lib/notifications";

type IoniconsName = keyof typeof Ionicons.glyphMap;

const tabIcons: Record<string, { focused: IoniconsName; default: IoniconsName }> = {
  Jobs: { focused: "briefcase", default: "briefcase-outline" },
  Agent: { focused: "flash", default: "flash-outline" },
  Devices: { focused: "laptop", default: "laptop-outline" },
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

function HeaderIcon() {
  return (
    <Pressable onPress={() => Linking.openURL("https://clawtab.cc")} style={{ marginRight: 12 }}>
      <Image
        source={require("../../assets/clawtab-icon.png")}
        style={{ width: 28, height: 28, borderRadius: 6 }}
      />
    </Pressable>
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
        headerRight: isWide ? undefined : () => <HeaderIcon />,
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
          title: "Jobs",
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
        name="devices"
        options={{
          title: "Devices",
          tabBarIcon: ({ focused }) => (
            <TabIcon label="Devices" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
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

  if (isWide) {
    return (
      <ResizableSidebar>
        <TabsContent isWide />
      </ResizableSidebar>
    );
  }

  return <TabsContent isWide={false} />;
}
