import { useEffect } from "react";
import { View, Text, Modal, Pressable as RNPressable, StyleSheet } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, Linking } from "react-native";
import { colors } from "../../src/theme/colors";
import { useResponsive } from "../../src/hooks/useResponsive";
import { registerNotificationCategories } from "../../src/lib/notifications";
import { NotificationsMenuButton } from "../../src/components/NotificationsMenuButton";
import { SettingsModalProvider, useSettingsModal } from "../../src/store/settingsModal";
import SettingsScreen from "./settings";

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
  const { open, show } = useSettingsModal();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 12 }}>
      <NotificationsMenuButton />
      <Pressable
        onPress={show}
        style={{
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: open ? colors.accentBg : "transparent",
        }}
      >
        <Ionicons name={open ? "settings" : "settings-outline"} size={16} color={open ? colors.accent : colors.textMuted} />
      </Pressable>
    </View>
  );
}

function SettingsModal() {
  const { open, hide } = useSettingsModal();
  const { isWide } = useResponsive();

  if (!isWide) return null;

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={hide}
    >
      <RNPressable style={modalStyles.backdrop} onPress={hide}>
        <RNPressable style={modalStyles.panel} onPress={(e) => e.stopPropagation()}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Settings</Text>
            <Pressable onPress={hide} style={modalStyles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <View style={modalStyles.body}>
            <SettingsScreen inModal />
          </View>
        </RNPressable>
      </RNPressable>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-start",
    alignItems: "flex-end",
  },
  panel: {
    width: 560,
    maxHeight: "90%",
    marginTop: 48,
    marginRight: 12,
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    flex: 1,
    overflow: "hidden",
  },
});

function TabsContent({ isWide }: { isWide: boolean }) {
  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerLeft: isWide ? () => <HeaderBrand /> : undefined,
        headerRight: isWide ? () => <HeaderRight /> : () => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: 12 }}>
            <NotificationsMenuButton />
            <HeaderBrand />
          </View>
        ),
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
        options={
          isWide
            ? { href: null }
            : {
                title: "Settings",
                tabBarIcon: ({ focused }) => <TabIcon label="Settings" focused={focused} />,
              }
        }
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const { isWide } = useResponsive();

  useEffect(() => {
    registerNotificationCategories();
  }, []);

  return (
    <SettingsModalProvider>
      <TabsContent isWide={isWide} />
      <SettingsModal />
    </SettingsModalProvider>
  );
}
