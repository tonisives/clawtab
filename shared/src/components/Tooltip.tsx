import { useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";

interface TooltipProps {
  label: string;
  children: React.ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  return <WebTooltip label={label}>{children}</WebTooltip>;
}

function WebTooltip({ label, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<View>(null);

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => setVisible(false), []);

  return (
    <View
      ref={containerRef}
      onPointerEnter={show}
      onPointerLeave={hide}
      style={styles.wrapper}
    >
      {children}
      {visible && (
        <View style={styles.tooltip}>
          <Text style={styles.tooltipText}>{label}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
  },
  tooltip: {
    position: "absolute",
    bottom: "100%",
    right: 0,
    marginBottom: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    zIndex: 100,
  },
  tooltipText: {
    color: colors.text,
    fontSize: 11,
    whiteSpace: "nowrap",
  } as any,
});
