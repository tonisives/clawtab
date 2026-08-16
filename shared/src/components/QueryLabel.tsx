import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

type QueryLabelProps = {
  shortLabel: "q" | "l";
  fullLabel: "Query" | "Latest";
};

export function QueryLabel({ shortLabel, fullLabel }: QueryLabelProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const showTooltip = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setTooltipVisible(true);
    timeoutRef.current = setTimeout(() => {
      setTooltipVisible(false);
      timeoutRef.current = null;
    }, 1800);
  }, []);

  return (
    <View style={styles.container}>
      <Pressable
        onPress={showTooltip}
        accessibilityRole="button"
        accessibilityLabel={fullLabel}
        hitSlop={4}
        {...(Platform.OS === "web" ? { title: fullLabel } as any : {})}
      >
        <Text style={styles.label}>{shortLabel}</Text>
      </Pressable>
      {tooltipVisible && (
        <View pointerEvents="none" style={styles.tooltip}>
          <Text style={styles.tooltipText}>{fullLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 16,
    flexShrink: 0,
    position: "relative",
  },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  tooltip: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    zIndex: 100,
    elevation: 100,
  },
  tooltipText: {
    color: colors.text,
    fontSize: 11,
    whiteSpace: "nowrap",
  } as any,
});
