import { useRef, useEffect } from "react";
import { View, StyleSheet, Animated, Platform } from "react-native";
import type { JobStatus } from "../types/job";
import { statusLabel, statusColor } from "../util/status";
import { Tooltip } from "./Tooltip";

const isWeb = Platform.OS === "web";

// Inject CSS keyframes once on web so we can avoid RN Animated's
// requestAnimationFrame-driven state updates (which can recursively
// dispatch inside a render and blow React's update-depth limit).
if (isWeb && typeof document !== "undefined") {
  const id = "status-badge-pulse-keyframes";
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `@keyframes statusBadgePulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`;
    document.head.appendChild(style);
  }
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const color = statusColor(status);
  const label = statusLabel(status);
  const running = status.state === "running";

  const pulse = useRef(isWeb ? null : new Animated.Value(1)).current as Animated.Value | null;

  useEffect(() => {
    if (isWeb || !pulse) return;
    if (running) {
      pulse.setValue(1);
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
  }, [running, pulse]);

  const dot = isWeb ? (
    <View
      style={[styles.dot, { backgroundColor: color }]}
      {...({
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: color,
          animation: running ? "statusBadgePulse 1.5s ease-in-out infinite" : undefined,
        },
      } as any)}
    />
  ) : (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity: running ? pulse! : 1 }]} />
  );

  return (
    <Tooltip label={label}>
      <View style={styles.container}>
        {dot}
      </View>
    </Tooltip>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
