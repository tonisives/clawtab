import { useEffect } from "react";
import { DarkTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator, Image, Platform, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../src/store/auth";
import { useWebSocket } from "../src/hooks/useWebSocket";
import { useJobsStore } from "../src/store/jobs";
import { useNotificationStore } from "../src/store/notifications";
import { loadCache } from "../src/lib/jobCache";
import { loadPendingAnswers } from "../src/lib/pendingAnswers";
import { handleColdStartAnswer, useNotifications } from "../src/hooks/useNotifications";
import { colors } from "../src/theme/colors";
import { NotificationsMenuButton } from "../src/components/NotificationsMenuButton";
import { useResponsive } from "../src/hooks/useResponsive";
import { useMobileHeaderStore } from "../src/store/mobileHeader";
import { useJobFilterStore } from "../src/store/jobFilter";

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    notification: colors.warning,
  },
};

function RootHeaderRight() {
  const isPad = Platform.OS === "ios" && Platform.isPad === true;
  return isPad ? (
    <NotificationsMenuButton variant="fluid" showDemoQuestions={false} />
  ) : (
    <NotificationsMenuButton countOnly showDemoQuestions={false} />
  );
}

let RootHeaderIcon = () => (
  <Image
    source={require("../assets/icon.png")}
    style={styles.headerIcon}
    accessibilityLabel="ClawTab"
  />
);

type MobileWebHeaderActionsProps = {
  isSettingsTab: boolean;
};

let MobileWebHeaderActions = ({ isSettingsTab }: MobileWebHeaderActionsProps) => {
  let router = useRouter();
  let openSearch = useJobFilterStore((state) => state.openSearch);

  let handleSearch = () => {
    if (isSettingsTab) {
      router.replace("/(tabs)");
      setTimeout(openSearch, 80);
      return;
    }
    openSearch();
  };

  let handleSectionChange = () => {
    router.replace(isSettingsTab ? "/(tabs)" : "/settings");
  };

  return (
    <View style={styles.mobileWebHeaderActions}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search jobs"
        hitSlop={8}
        onPress={handleSearch}
        style={styles.headerActionButton}
      >
        <Ionicons name="search" size={20} color={colors.text} />
      </Pressable>
      <NotificationsMenuButton countOnly showDemoQuestions={false} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isSettingsTab ? "Jobs" : "Settings"}
        hitSlop={8}
        onPress={handleSectionChange}
        style={styles.headerActionButton}
      >
        <Ionicons
          name={isSettingsTab ? "briefcase-outline" : "settings-outline"}
          size={20}
          color={colors.text}
        />
      </Pressable>
    </View>
  );
}

function useWebDarkScrollbars() {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const style = document.createElement("style");
    style.textContent = `
      html { color-scheme: dark; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);
}

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Reset stores to clear any stale data from a previous account
    useJobsStore.setState({ jobs: [], statuses: {}, detectedProcesses: [], agentActivity: {}, questionPaneIds: new Set(), queryDetailsHiddenPaneIds: new Set(), loaded: false, cachedLoad: false, processesLoaded: false });
    useNotificationStore.getState().reset();

    loadCache().then((cached) => {
      if (cached) {
        useJobsStore.getState().hydrateFromCache(cached.jobs, cached.statuses);
        if (cached.questions.length > 0) {
          useJobsStore.getState().setQuestionPanes(cached.questions.map((question) => question.pane_id));
          useNotificationStore.getState().hydrateQuestionsFromCache(cached.questions);
        }
      }
    });
    loadPendingAnswers();
  }, []);

  useWebSocket();
  useNotifications();
  return <>{children}</>;
}

export default function RootLayout() {
  useWebDarkScrollbars();
  const { isIosPadPortrait, isSplitView, isWide } = useResponsive();
  const mobileHeaderTab = useMobileHeaderStore((s) => s.tab);
  const loading = useAuthStore((s) => s.loading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const init = useAuthStore((s) => s.init);
  const isSettingsTab = mobileHeaderTab === "settings";
  const isMobileWeb = Platform.OS === "web" && !isWide && !isSplitView;

  useEffect(() => {
    init();
    handleColdStartAnswer();
  }, [init]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
        <StatusBar style="light" />
      </View>
    );
  }

  const content = (
    <ThemeProvider value={navTheme}>
      <View style={styles.root}>
        <Stack screenOptions={{ headerShown: false, animation: "none" }}>
          <Stack.Screen
            name="(tabs)"
            options={{
              animation: "none",
              headerShown: !isWide && !isSplitView && !isIosPadPortrait,
              title: isSplitView ? "" : isSettingsTab ? "Settings" : "ClawTab",
              headerLargeTitle: !isMobileWeb,
              headerTransparent: !isMobileWeb,
              headerStyle: { backgroundColor: isMobileWeb ? colors.bg : "transparent" },
              headerTintColor: colors.text,
              headerShadowVisible: isMobileWeb,
              headerLargeTitleStyle: styles.headerLargeTitle,
              headerTitleStyle: styles.headerTitle,
              headerTitle: isMobileWeb ? () => <RootHeaderIcon /> : undefined,
              headerRight: isSplitView || isIosPadPortrait
                ? () => null
                : isMobileWeb
                  ? () => <MobileWebHeaderActions isSettingsTab={isSettingsTab} />
                  : () => <RootHeaderRight />,
            }}
          />
          <Stack.Screen name="job/[name]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="process/[pane_id]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen
            name="notifications"
            options={{
              animation: "slide_from_bottom",
              presentation: "modal",
              headerShown: false,
            }}
          />
        </Stack>
        <StatusBar style="light" />
      </View>
    </ThemeProvider>
  );

  if (!isAuthenticated) {
    return content;
  }

  return (
    <WebSocketProvider>
      {content}
    </WebSocketProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  headerLargeTitle: {
    color: colors.text,
    fontWeight: "700",
  },
  headerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  headerIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
  },
  mobileWebHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginRight: 4,
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
});
