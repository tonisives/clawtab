import { ActivityIndicator, StyleSheet, Text, View } from "react-native"
import { colors } from "@clawtab/shared"

interface LoadingBarProps {
  label: string
  progress: number
  error?: boolean
}

export function LoadingBar({ label, progress, error = false }: LoadingBarProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        {!error ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        <Text style={[styles.text, error && styles.errorText]}>{label}</Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              width: `${Math.max(0.08, Math.min(1, progress)) * 100}%`,
              backgroundColor: error ? colors.danger : colors.accent,
            },
          ]}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    maxWidth: 320,
    gap: 8,
  },
  header: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: colors.border,
  },
  fill: {
    height: "100%",
    borderRadius: 2,
  },
  text: {
    color: colors.textMuted,
    fontSize: 13,
  },
  errorText: {
    color: colors.danger,
  },
})
