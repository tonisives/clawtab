import { useRef, useCallback, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Platform, Image, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { colors } from "../theme/colors";
import { useSidebarStore } from "../store/sidebar";

type IoniconsName = keyof typeof Ionicons.glyphMap;

const NAV_ITEMS = [
  { route: "/(tabs)", label: "Jobs", icon: "briefcase-outline" as IoniconsName, iconFocused: "briefcase" as IoniconsName },
  { route: "/(tabs)/devices", label: "Devices", icon: "laptop-outline" as IoniconsName, iconFocused: "laptop" as IoniconsName },
  { route: "/(tabs)/settings", label: "Settings", icon: "settings-outline" as IoniconsName, iconFocused: "settings" as IoniconsName },
];

function isActive(pathname: string, route: string): boolean {
  if (route === "/(tabs)") return pathname === "/" || pathname === "/(tabs)" || pathname === "/(tabs)/index";
  return pathname.startsWith(route);
}

export function ResizableSidebar({ children }: { children: React.ReactNode }) {
  const width = useSidebarStore((s) => s.width);
  const setWidth = useSidebarStore((s) => s.setWidth);
  const pathname = usePathname();
  const router = useRouter();
  const handleRef = useRef<View>(null);

  const collapsed = width < 100;

  useEffect(() => {
    if (Platform.OS !== "web" || !handleRef.current) return;

    const el = handleRef.current as unknown as HTMLElement;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.pageX;
      const startW = useSidebarStore.getState().width;

      const onMouseMove = (ev: MouseEvent) => {
        setWidth(startW + (ev.pageX - startX));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [setWidth]);

  return (
    <View style={styles.root}>
      <View style={[styles.sidebar, { width }]}>
        <Pressable
          onPress={() => Linking.openURL("https://clawtab.cc")}
          style={styles.brand}
        >
          <Image
            source={require("../../assets/clawtab-icon.png")}
            style={styles.brandIcon}
          />
          {!collapsed && <Text style={styles.brandText}>ClawTab</Text>}
        </Pressable>

        <View style={styles.nav}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.route);
            return (
              <Pressable
                key={item.route}
                style={[styles.navItem, active && styles.navItemActive]}
                onPress={() => router.push(item.route as any)}
              >
                <Ionicons
                  name={active ? item.iconFocused : item.icon}
                  size={20}
                  color={active ? colors.accent : colors.textMuted}
                />
                {!collapsed && (
                  <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                    {item.label}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      <View ref={handleRef} style={styles.handle} />

      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: "row",
  },
  sidebar: {
    backgroundColor: colors.bg,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: 12,
    paddingBottom: 12,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 8,
  },
  brandIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
  },
  brandText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  nav: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 8,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  navItemActive: {
    backgroundColor: colors.accentBg,
  },
  navLabel: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "500",
  },
  navLabelActive: {
    color: colors.accent,
  },
  handle: {
    width: 5,
    ...(Platform.OS === "web" ? { cursor: "col-resize" as any } : {}),
    backgroundColor: "transparent",
    marginLeft: -3,
    marginRight: -2,
    zIndex: 10,
  },
  content: {
    flex: 1,
  },
});
