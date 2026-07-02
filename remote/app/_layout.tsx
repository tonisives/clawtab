import { useEffect } from "react";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
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
  return <NotificationsMenuButton countOnly showDemoQuestions={false} />;
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
    useJobsStore.setState({ jobs: [], statuses: {}, detectedProcesses: [], loaded: false, cachedLoad: false, processesLoaded: false });
    useNotificationStore.getState().reset();

    loadCache().then((cached) => {
      if (cached) {
        useJobsStore.getState().hydrateFromCache(cached.jobs, cached.statuses);
        if (cached.questions.length > 0) {
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
  const { isWide } = useResponsive();
  const mobileHeaderTab = useMobileHeaderStore((s) => s.tab);
  const loading = useAuthStore((s) => s.loading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const init = useAuthStore((s) => s.init);
  const isSettingsTab = mobileHeaderTab === "settings";

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
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen
            name="(tabs)"
            options={{
              headerShown: !isWide,
              title: isSettingsTab ? "Settings" : "ClawTab",
              headerLargeTitle: true,
              headerTransparent: true,
              headerStyle: { backgroundColor: "transparent" },
              headerTintColor: colors.text,
              headerShadowVisible: false,
              headerLargeTitleStyle: styles.headerLargeTitle,
              headerTitleStyle: styles.headerTitle,
              headerRight: isSettingsTab ? () => null : () => <RootHeaderRight />,
            }}
          />
          <Stack.Screen
            name="notifications"
            options={{
              headerShown: true,
              title: "Notifications",
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
              headerTitleStyle: styles.headerTitle,
              headerShadowVisible: true,
              headerBackTitle: "",
              headerBackButtonDisplayMode: "minimal",
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
});
