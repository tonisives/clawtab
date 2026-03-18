import { useEffect, useState, useCallback } from "react";
import {
  FlatList,
  View,
  Text,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { getDevices, type DeviceInfo } from "../../src/api/client";
import { DeviceCard } from "../../src/components/DeviceCard";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { spacing } from "../../src/theme/spacing";

export default function DevicesScreen() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { isWide } = useResponsive();

  const fetchDevices = useCallback(async () => {
    try {
      const d = await getDevices();
      setDevices(d);
    } catch (e) {
      console.error("Failed to fetch devices:", e);
    }
  }, []);

  useEffect(() => {
    fetchDevices().finally(() => setLoading(false));
  }, [fetchDevices]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchDevices();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ContentContainer fill>
        <FlatList
          data={devices}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => <DeviceCard device={item} />}
          contentContainerStyle={[styles.list, isWide && styles.listWide]}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Desktop not connected</Text>
              <Text style={styles.emptyText}>
                Please install ClawTab desktop and sign in to same account.
              </Text>
              <Pressable onPress={() => openUrl("https://clawtab.cc/docs#quick-start")}>
                <Text style={styles.linkText}>Quick Start Guide</Text>
              </Pressable>
            </View>
          }
        />
      </ContentContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  list: {
    padding: spacing.lg,
  },
  listWide: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  empty: {
    alignItems: "center",
    paddingTop: 100,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  linkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "500" as const,
  },
});
