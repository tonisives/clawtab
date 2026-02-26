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
import { getDevices, createCheckout, getPaymentLink, type DeviceInfo } from "../../src/api/client";
import { DeviceCard } from "../../src/components/DeviceCard";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useWsStore } from "../../src/store/ws";
import { useResponsive } from "../../src/hooks/useResponsive";
import { alertError, openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

const DEMO_DEVICES = [
  { name: "MacBook Pro", online: true, meta: "Online" },
  { name: "Mac Mini", online: false, meta: "Offline - last seen Feb 20, 2026" },
];

export default function DevicesScreen() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subLoading, setSubLoading] = useState(false);
  const subscriptionRequired = useWsStore((s) => s.subscriptionRequired);
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
    if (!subscriptionRequired) {
      fetchDevices().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [fetchDevices, subscriptionRequired]);

  const handleSubscribe = async () => {
    setSubLoading(true);
    try {
      let url: string;
      try {
        ({ url } = await createCheckout());
      } catch {
        ({ url } = await getPaymentLink());
      }
      await openUrl(url);
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setSubLoading(false);
    }
  };

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

  if (subscriptionRequired) {
    return (
      <View style={styles.container}>
        <ContentContainer>
          <View style={[styles.subBanner, isWide && styles.subBannerWide]}>
            <Text style={styles.subTitle}>Subscription required</Text>
            <Text style={[styles.subText, isWide && { maxWidth: 400 }]}>
              Subscribe to view your devices and connect remotely.
            </Text>
            <Pressable
              style={[styles.subBtn, subLoading && styles.btnDisabled]}
              onPress={handleSubscribe}
              disabled={subLoading}
            >
              <Text style={styles.subBtnText}>{subLoading ? "Loading..." : "Subscribe"}</Text>
            </Pressable>
          </View>
          <View style={[styles.demoList, { pointerEvents: "none" as const }]}>
            {DEMO_DEVICES.map((d, i) => (
              <View key={d.name} style={[styles.demoCard, i > 0 && { marginTop: spacing.sm }]}>
                <View style={styles.demoRow}>
                  <View style={[styles.demoDot, { backgroundColor: d.online ? colors.success : colors.textMuted }]} />
                  <View style={styles.demoInfo}>
                    <Text style={styles.demoName}>{d.name}</Text>
                    <Text style={styles.demoMeta}>{d.meta}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </ContentContainer>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ContentContainer>
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
              <Text style={styles.emptyTitle}>No devices</Text>
              <Text style={styles.emptyText}>
                Pair a desktop from the ClawTab desktop app.
              </Text>
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
  subBanner: {
    padding: spacing.xl,
    alignItems: "center" as const,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  subBannerWide: {
    paddingVertical: 48,
  },
  subTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600" as const,
  },
  subText: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center" as const,
  },
  subBtn: {
    height: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  subBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600" as const,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  demoList: {
    padding: spacing.lg,
    opacity: 0.35,
  },
  demoCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  demoRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.md,
  },
  demoDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  demoInfo: {
    flex: 1,
    gap: 2,
  },
  demoName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500" as const,
  },
  demoMeta: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
