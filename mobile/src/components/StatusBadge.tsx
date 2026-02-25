import { useRef, useEffect } from "react";
import { Text, StyleSheet, Animated } from "react-native";
import type { JobStatus } from "../types/job";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

function statusStyle(status: JobStatus): { color: string; bg: string } {
  switch (status.state) {
    case "idle":
      return { color: colors.statusIdle, bg: "transparent" };
    case "running":
      return { color: colors.statusRunning, bg: colors.accentBg };
    case "success":
      return { color: colors.statusSuccess, bg: colors.successBg };
    case "failed":
      return { color: colors.statusFailed, bg: colors.dangerBg };
    case "paused":
      return { color: colors.statusPaused, bg: colors.warningBg };
  }
}

function statusLabel(status: JobStatus): string {
  switch (status.state) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "failed":
      return `Failed (${status.exit_code})`;
    case "paused":
      return "Paused";
  }
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const { color, bg } = statusStyle(status);
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
  }, [status.state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View style={[styles.badge, { backgroundColor: bg, opacity: status.state === "running" ? pulse : 1 }]}>
      <Text style={[styles.label, { color }]}>{statusLabel(status)}</Text>
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
