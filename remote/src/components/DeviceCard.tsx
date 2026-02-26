import { View, Text, StyleSheet } from "react-native";
import type { DeviceInfo } from "../api/client";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function DeviceCard({ device }: { device: DeviceInfo }) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: device.is_online
                ? colors.success
                : colors.textMuted,
            },
          ]}
        />
        <View style={styles.info}>
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.meta}>
            {device.is_online ? "Online" : "Offline"}
            {device.last_seen
              ? ` - last seen ${new Date(device.last_seen).toLocaleDateString()}`
              : ""}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  meta: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
