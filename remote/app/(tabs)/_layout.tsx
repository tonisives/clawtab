import { useEffect, useState, type ComponentType, type PropsWithChildren } from "react";
import { Modal, View, Text, StyleSheet } from "react-native";
import { Tabs, usePathname } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, Linking } from "react-native";
import { colors } from "../../src/theme/colors";
import { useResponsive } from "../../src/hooks/useResponsive";
import { registerNotificationCategories } from "../../src/lib/notifications";
import { NotificationsMenuButton } from "../../src/components/NotificationsMenuButton";
import { useJobFilterStore } from "../../src/store/jobFilter";
import { useMobileHeaderStore } from "../../src/store/mobileHeader";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SettingsScreen from "./settings";

type IoniconsName = keyof typeof Ionicons.glyphMap;
const NativeTabsRoot = NativeTabs as ComponentType<PropsWithChildren<any>>;

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
        source={require("../../assets/icon.png")}
        style={{ width: 24, height: 24, borderRadius: 5 }}
      />
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "700" }}>ClawTab</Text>
    </Pressable>
  );
}

function HeaderRight() {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <View style={styles.headerActions}>
      <NotificationsMenuButton />
      <Pressable
        onPress={() => setSettingsOpen(true)}
        style={[styles.headerActionButton, (settingsActive || settingsOpen) && styles.headerActionButtonActive]}
      >
        <Ionicons
          name={settingsActive || settingsOpen ? "settings" : "settings-outline"}
          size={18}
          color={settingsActive || settingsOpen ? colors.accent : colors.textMuted}
        />
      </Pressable>
      <Modal
        visible={settingsOpen}
        transparent
        animationType="slide"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View style={[styles.fullScreenModal, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Pressable onPress={() => setSettingsOpen(false)} style={styles.modalCloseButton}>
              <Ionicons name="close" size={20} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.modalBody}>
            <SettingsScreen inModal />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function TabsContent({ isWide }: { isWide: boolean }) {
  const openSearch = useJobFilterStore((s) => s.openSearch);
  const setMobileHeaderTab = useMobileHeaderStore((s) => s.setTab);
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";

  useEffect(() => {
    setMobileHeaderTab(settingsActive ? "settings" : "jobs");
  }, [settingsActive, setMobileHeaderTab]);

  if (!isWide) {
    return (
      <View style={styles.nativeTabsFrame}>
        <NativeTabsRoot
          tintColor={colors.accent}
          iconColor={{ default: colors.textMuted, selected: colors.accent }}
          backgroundColor={colors.bg}
          blurEffect="systemChromeMaterialDark"
          shadowColor={colors.border}
          minimizeBehavior="onScrollDown"
        >
          <NativeTabs.Trigger
            name="index"
            contentStyle={{ backgroundColor: colors.bg }}
            listeners={{ tabPress: () => setMobileHeaderTab("jobs") }}
          >
            <NativeTabs.Trigger.Label>Jobs</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "briefcase", selected: "briefcase.fill" }}
              md={{ default: "work_outline", selected: "work" }}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name="settings"
            contentStyle={{ backgroundColor: colors.bg }}
            listeners={{ tabPress: () => setMobileHeaderTab("settings") }}
          >
            <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "gearshape", selected: "gearshape.fill" }}
              md={{ default: "settings", selected: "settings" }}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name="search"
            role="search"
            disabled
            contentStyle={{ backgroundColor: colors.bg }}
            listeners={{
              tabPress: () => {
                if (!settingsActive) openSearch();
              },
            }}
          />
          <NativeTabs.Trigger name="agent" hidden />
          <NativeTabs.Trigger name="connection" hidden />
          <NativeTabs.Trigger name="devices" hidden />
        </NativeTabsRoot>
        {settingsActive ? <View pointerEvents="none" style={styles.hiddenSearchCover} /> : null}
      </View>
    );
  }

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerShown: !isWide,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerLeft: undefined,
        headerRight: () => (
          <View style={{ marginRight: 12 }}>
            <NotificationsMenuButton />
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
          title: "",
          tabBarLabel: "Jobs",
          ...(!isWide ? { headerLeft: () => <HeaderBrand /> } : {}),
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
      <Tabs.Screen
        name="search"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  layoutRoot: {
    flex: 1,
  },
  headerActions: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 1000,
    elevation: 1000,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerActionButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerActionButtonActive: {
    backgroundColor: colors.accentBg,
    borderColor: "rgba(121, 134, 203, 0.32)",
  },
  fullScreenModal: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
  },
  modalHeader: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  modalCloseButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBody: {
    flex: 1,
    overflow: "hidden",
  },
  nativeTabsFrame: {
    flex: 1,
  },
  hiddenSearchCover: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 112,
    height: 96,
    backgroundColor: colors.bg,
    zIndex: 1000,
    elevation: 1000,
  },
});

export default function TabLayout() {
  const { isWide } = useResponsive();

  useEffect(() => {
    registerNotificationCategories();
  }, []);

  return (
    <View style={styles.layoutRoot}>
      <TabsContent isWide={isWide} />
      {isWide ? <HeaderRight /> : null}
    </View>
  );
}
