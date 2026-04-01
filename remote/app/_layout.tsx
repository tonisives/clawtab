import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator, StyleSheet, Platform, InputAccessoryView, TouchableOpacity, Text, Keyboard } from "react-native";
import { useAuthStore } from "../src/store/auth";
import { useWebSocket } from "../src/hooks/useWebSocket";
import { useJobsStore } from "../src/store/jobs";
import { useNotificationStore } from "../src/store/notifications";
import { loadCache } from "../src/lib/jobCache";
import { loadPendingAnswers } from "../src/lib/pendingAnswers";
import { handleColdStartAnswer, useNotifications } from "../src/hooks/useNotifications";
import { colors } from "../src/theme/colors";

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
  const loading = useAuthStore((s) => s.loading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const init = useAuthStore((s) => s.init);

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
    <View style={styles.root}>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="light" />
      {Platform.OS === "ios" && (
        <InputAccessoryView nativeID="keyboard-dismiss">
          <View style={styles.keyboardBar}>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => Keyboard.dismiss()} activeOpacity={0.6}>
              <Text style={styles.keyboardDone}>Done</Text>
            </TouchableOpacity>
          </View>
        </InputAccessoryView>
      )}
    </View>
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
  keyboardBar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  keyboardDone: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
});
