import { useEffect } from "react";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useAuthStore } from "../src/store/auth";
import { useWebSocket } from "../src/hooks/useWebSocket";
import { colors } from "../src/theme/colors";

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return <>{children}</>;
}

export default function RootLayout() {
  const loading = useAuthStore((s) => s.loading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
        <StatusBar style="light" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={styles.root}>
        <Slot />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <WebSocketProvider>
      <View style={styles.root}>
        <Slot />
        <StatusBar style="light" />
      </View>
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
});
