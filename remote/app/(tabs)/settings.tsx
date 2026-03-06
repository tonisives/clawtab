import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, TextInput } from "react-native";
import { useAuthStore } from "../../src/store/auth";
import { useWsStore } from "../../src/store/ws";
import { ContentContainer } from "../../src/components/ContentContainer";
import { DeviceCard } from "../../src/components/DeviceCard";
import { useResponsive } from "../../src/hooks/useResponsive";
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

  const [shares, setShares] = useState<api.SharesResponse>({ shared_by_me: [], shared_with_me: [] });
  const [sharesLoading, setSharesLoading] = useState(true);
  const [shareEmail, setShareEmail] = useState("");
  const [shareAdding, setShareAdding] = useState(false);

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
      const { url } = await api.createCheckout();
      await openUrl(url);
      const updated = await api.getSubscriptionStatus();
      setSub(updated);
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleManageBilling = async () => {
    setActionLoading(true);
    try {
      const { url } = await api.createPortal();
      await openUrl(url);
      const updated = await api.getSubscriptionStatus();
      setSub(updated);
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddShare = async () => {
    const email = shareEmail.trim();
    if (!email) return;
    setShareAdding(true);
    try {
      await api.addShare(email);
      setShareEmail("");
      await fetchShares();
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setShareAdding(false);
    }
  };

  const handleRemoveShare = (shareId: string, email: string) => {
    confirm("Remove access", `Remove shared access for ${email}?`, async () => {
      try {
        await api.removeShare(shareId);
        await fetchShares();
      } catch (e) {
        alertError("Error", String(e));
      }
    });
  };

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
                      {actionLoading ? "Loading..." : "Manage Billing"}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[styles.subscribeBtn, actionLoading && styles.btnDisabled]}
                    onPress={handleSubscribe}
                    disabled={actionLoading}
                  >
                    <Text style={styles.subscribeBtnText}>
                      {actionLoading ? "Loading..." : "Subscribe"}
                    </Text>
                  </Pressable>
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
              <>
                <View style={styles.shareInputRow}>
                  <TextInput
                    style={styles.shareInput}
                    placeholder="Email address"
                    placeholderTextColor={colors.textMuted}
                    value={shareEmail}
                    onChangeText={setShareEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={handleAddShare}
                  />
                  <Pressable
                    style={[styles.shareAddBtn, (shareAdding || !shareEmail.trim()) && styles.btnDisabled]}
                    onPress={handleAddShare}
                    disabled={shareAdding || !shareEmail.trim()}
                  >
                    <Text style={styles.shareAddBtnText}>
                      {shareAdding ? "..." : "Share"}
                    </Text>
                  </Pressable>
                </View>
                {shares.shared_by_me.length > 0 && (
                  <View style={styles.devicesList}>
                    {shares.shared_by_me.map((share) => (
                      <View key={share.id} style={styles.shareRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.shareEmail}>{share.email}</Text>
                          {share.display_name && (
                            <Text style={styles.shareDisplayName}>{share.display_name}</Text>
                          )}
                        </View>
                        <Pressable onPress={() => handleRemoveShare(share.id, share.email)}>
                          <Text style={styles.shareRemove}>Remove</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
                {shares.shared_with_me.length > 0 && (
                  <>
                    <Text style={styles.shareSubTitle}>Shared with me</Text>
                    <View style={styles.devicesList}>
                      {shares.shared_with_me.map((share) => (
                        <View key={share.id} style={styles.shareRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.shareEmail}>{share.owner_email}</Text>
                            {share.owner_display_name && (
                              <Text style={styles.shareDisplayName}>{share.owner_display_name}</Text>
                            )}
                          </View>
                          <Pressable onPress={() => handleRemoveShare(share.id, share.owner_email)}>
                            <Text style={styles.shareRemove}>Leave</Text>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </>
                )}
              </>
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
  shareInputRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  shareInput: {
    flex: 1,
    height: 44,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 14,
  },
  shareAddBtn: {
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  shareAddBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shareEmail: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  shareDisplayName: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  shareSubTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.sm,
  },
  shareRemove: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "500",
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
