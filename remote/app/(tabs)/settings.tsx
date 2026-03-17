import { useEffect, useState, useCallback, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Platform } from "react-native";
import { useAuthStore } from "../../src/store/auth";
import { useWsStore } from "../../src/store/ws";
import { useJobsStore } from "../../src/store/jobs";
import { ContentContainer } from "../../src/components/ContentContainer";
import { DeviceCard } from "../../src/components/DeviceCard";
import { useResponsive } from "../../src/hooks/useResponsive";
import { useIap } from "../../src/hooks/useIap";
import { ShareSection } from "@clawtab/shared";
import * as api from "../../src/api/client";
import { confirm, alertError, openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

type SubStatus = api.SubscriptionStatus | null;

function statusColor(status: string | null): string {
  switch (status) {
    case "active":
    case "trialing":
      return colors.success;
    case "canceled":
    case "past_due":
      return colors.danger;
    default:
      return colors.textMuted;
  }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "active":
      return "Active";
    case "trialing":
      return "Trial";
    case "canceled":
      return "Canceled";
    case "past_due":
      return "Past Due";
    default:
      return "None";
  }
}

export default function SettingsScreen() {
  const userId = useAuthStore((s) => s.userId);
  const email = useAuthStore((s) => s.email);
  const logout = useAuthStore((s) => s.logout);
  const connected = useWsStore((s) => s.connected);
  const { isWide } = useResponsive();

  const [sub, setSub] = useState<SubStatus>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [devices, setDevices] = useState<api.DeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const subscriptionRequired = useWsStore((s) => s.subscriptionRequired);

  const iap = useIap();

  const [shares, setShares] = useState<api.SharesResponse>({ shared_by_me: [], shared_with_me: [] });
  const [sharesLoading, setSharesLoading] = useState(true);

  const jobs = useJobsStore((s) => s.jobs);
  const availableGroups = useMemo(() => {
    const groups = new Set(jobs.map((j) => j.group || "default"));
    return [...groups].sort();
  }, [jobs]);

  const fetchDevices = useCallback(async () => {
    try {
      const d = await api.getDevices();
      setDevices(d);
    } catch (e) {
      console.error("Failed to fetch devices:", e);
    }
  }, []);

  useEffect(() => {
    api.getSubscriptionStatus()
      .then(setSub)
      .catch(() => setSub(null))
      .finally(() => setSubLoading(false));
  }, []);

  const fetchShares = useCallback(async () => {
    try {
      const s = await api.getShares();
      setShares(s);
    } catch (e) {
      console.error("Failed to fetch shares:", e);
    }
  }, []);

  useEffect(() => {
    if (!subscriptionRequired) {
      fetchDevices().finally(() => setDevicesLoading(false));
      fetchShares().finally(() => setSharesLoading(false));
    } else {
      setDevicesLoading(false);
      setSharesLoading(false);
    }
  }, [fetchDevices, fetchShares, subscriptionRequired]);

  const handleSubscribe = async () => {
    setActionLoading(true);
    try {
      if (iap.available) {
        const success = await iap.purchase();
        if (success) {
          const updated = await api.getSubscriptionStatus();
          setSub(updated);
        }
      } else {
        const { url } = await api.createCheckout();
        await openUrl(url);
        const updated = await api.getSubscriptionStatus();
        setSub(updated);
      }
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestorePurchases = async () => {
    setActionLoading(true);
    try {
      const success = await iap.restore();
      if (success) {
        const updated = await api.getSubscriptionStatus();
        setSub(updated);
      } else {
        alertError("Restore", "No active subscription found");
      }
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleManageBilling = async () => {
    setActionLoading(true);
    try {
      if (Platform.OS === "ios") {
        // On iOS, open the App Store subscription management
        await openUrl("https://apps.apple.com/account/subscriptions");
      } else {
        const { url } = await api.createPortal();
        await openUrl(url);
      }
      const updated = await api.getSubscriptionStatus();
      setSub(updated);
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddShare = useCallback(async (email: string) => {
    await api.addShare(email);
    await fetchShares();
  }, [fetchShares]);

  const handleToggleGroup = useCallback(async (shareId: string, group: string) => {
    const share = shares.shared_by_me.find((s) => s.id === shareId);
    if (!share) return;

    let newGroups: string[] | null;
    if (share.allowed_groups === null) {
      newGroups = availableGroups.filter((g) => g !== group);
    } else if (share.allowed_groups.includes(group)) {
      newGroups = share.allowed_groups.filter((g) => g !== group);
      if (newGroups.length === 0) newGroups = null;
    } else {
      newGroups = [...share.allowed_groups, group];
      if (availableGroups.every((g) => newGroups!.includes(g))) {
        newGroups = null;
      }
    }

    // Optimistic update
    setShares((prev) => ({
      ...prev,
      shared_by_me: prev.shared_by_me.map((s) =>
        s.id === shareId ? { ...s, allowed_groups: newGroups } : s,
      ),
    }));

    try {
      await api.updateShare(shareId, newGroups);
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e));
      await fetchShares();
    }
  }, [shares, availableGroups, fetchShares]);

  const handleRemoveShare = useCallback((shareId: string, email: string) => {
    confirm("Remove access", `Remove shared access for ${email}?`, async () => {
      try {
        await api.removeShare(shareId);
        await fetchShares();
      } catch (e) {
        alertError("Error", e instanceof Error ? e.message : String(e));
      }
    });
  }, [fetchShares]);

  const handleLogout = () => {
    confirm("Log out", "Are you sure you want to log out?", () => logout());
  };

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={{ flexGrow: 1 }}>
      <ContentContainer>
        <View style={[styles.container, isWide && styles.containerWide]}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Account</Text>
            {email && (
              <View style={styles.row}>
                <Text style={styles.label}>Email</Text>
                <Text style={styles.value} numberOfLines={1}>
                  {email}
                </Text>
              </View>
            )}
            <View style={styles.row}>
              <Text style={styles.label}>Connection</Text>
              <Text
                style={[
                  styles.value,
                  { color: connected ? colors.success : colors.textMuted },
                ]}
              >
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Subscription</Text>
            {subLoading ? (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : (
              <>
                <View style={styles.row}>
                  <Text style={styles.label}>Status</Text>
                  <Text style={[styles.value, { color: statusColor(sub?.status ?? null) }]}>
                    {statusLabel(sub?.status ?? null)}
                  </Text>
                </View>
                {sub?.current_period_end && (
                  <View style={styles.row}>
                    <Text style={styles.label}>Period ends</Text>
                    <Text style={styles.value}>
                      {new Date(sub.current_period_end).toLocaleDateString()}
                    </Text>
                  </View>
                )}
                {sub?.subscribed ? (
                  <Pressable
                    style={[styles.billingBtn, actionLoading && styles.btnDisabled]}
                    onPress={handleManageBilling}
                    disabled={actionLoading}
                  >
                    <Text style={styles.billingBtnText}>
                      {actionLoading ? "Loading..." : "Manage Subscription"}
                    </Text>
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      style={[styles.subscribeBtn, (actionLoading || iap.purchasing) && styles.btnDisabled]}
                      onPress={handleSubscribe}
                      disabled={actionLoading || iap.purchasing}
                    >
                      <Text style={styles.subscribeBtnText}>
                        {actionLoading || iap.purchasing
                          ? "Loading..."
                          : iap.price
                            ? `Subscribe - ${iap.price}/mo`
                            : "Subscribe"}
                      </Text>
                    </Pressable>
                    {iap.available && (
                      <Pressable
                        style={[styles.billingBtn, actionLoading && styles.btnDisabled]}
                        onPress={handleRestorePurchases}
                        disabled={actionLoading || iap.purchasing}
                      >
                        <Text style={styles.billingBtnText}>Restore Purchases</Text>
                      </Pressable>
                    )}
                  </>
                )}
              </>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Devices</Text>
            {devicesLoading ? (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : subscriptionRequired ? (
              <View style={styles.row}>
                <Text style={styles.label}>Subscribe to view devices</Text>
              </View>
            ) : devices.length === 0 ? (
              <View style={styles.row}>
                <Text style={styles.label}>No devices paired</Text>
              </View>
            ) : (
              <View style={styles.devicesList}>
                {devices.map((device) => (
                  <DeviceCard key={device.id} device={device} />
                ))}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Shared Access</Text>
            {sharesLoading ? (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : subscriptionRequired ? (
              <View style={styles.row}>
                <Text style={styles.label}>Subscribe to manage sharing</Text>
              </View>
            ) : (
              <ShareSection
                sharedByMe={shares.shared_by_me}
                sharedWithMe={shares.shared_with_me}
                availableGroups={availableGroups}
                loading={sharesLoading}
                onAdd={handleAddShare}
                onToggleGroup={handleToggleGroup}
                onRemove={handleRemoveShare}
                onLeave={handleRemoveShare}
              />
            )}
          </View>

          <View style={styles.section}>
            <Pressable style={[styles.dangerBtn, isWide && styles.btnConstrained]} onPress={handleLogout}>
              <Text style={styles.dangerText}>Log Out</Text>
            </Pressable>
          </View>
        </View>
      </ContentContainer>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.xl,
  },
  containerWide: {
    paddingTop: 48,
  },
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
    maxWidth: "60%",
  },
  devicesList: {
    gap: spacing.sm,
  },
  billingBtn: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  billingBtnText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  subscribeBtn: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  subscribeBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnConstrained: {
    alignSelf: "flex-start",
    paddingHorizontal: 48,
  },
  dangerBtn: {
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    justifyContent: "center",
    alignItems: "center",
  },
  dangerText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "600",
  },
});
