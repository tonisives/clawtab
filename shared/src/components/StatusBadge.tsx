import { useRef, useEffect } from "react";
import { Text, StyleSheet, Animated, Platform } from "react-native";
import type { JobStatus } from "../types/job";
import { statusLabel, statusColor, statusBg } from "../util/status";
import { spacing } from "../theme/spacing";

const isNative = Platform.OS !== "web";

export function StatusBadge({ status }: { status: JobStatus }) {
  const color = statusColor(status);
  const bg = statusBg(status);
  const label = statusLabel(status);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (status.state === "running") {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 0.5, duration: 750, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    }
    pulse.setValue(1);
  }, [status.state, pulse]);

  return (
    <Animated.View style={[styles.badge, !isNative && { backgroundColor: bg }, { opacity: status.state === "running" ? pulse : 1 }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
});
