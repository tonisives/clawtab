import { useRef, useEffect } from "react";
import { View, StyleSheet, Animated } from "react-native";
import type { JobStatus } from "../types/job";
import { statusLabel, statusColor } from "../util/status";
import { Tooltip } from "./Tooltip";

export function StatusBadge({ status }: { status: JobStatus }) {
  const color = statusColor(status);
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

  const dot = (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity: status.state === "running" ? pulse : 1 }]} />
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
