import { Platform, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from "react-native"
import { colors } from "../theme/colors"

type Props<T extends string> = {
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (value: T) => void
  compact?: boolean
  stretch?: boolean
  style?: StyleProp<ViewStyle>
}

export function SegmentedControl<T extends string>({ label, options, value, onChange, compact = false, stretch = false, style }: Props<T>) {
  return <View role="group" accessibilityLabel={label} style={[styles.group, style]}>
    {options.map((option) => {
      let selected = option.value === value
      return <TouchableOpacity
        key={option.value}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        aria-pressed={selected}
        activeOpacity={0.7}
        onPress={(event) => { event.stopPropagation(); onChange(option.value) }}
        style={[styles.button, compact && styles.compactButton, stretch && styles.stretch, { backgroundColor: selected ? colors.accent : "transparent" }]}
      >
        <Text style={[styles.text, { color: selected ? "#ffffff" : colors.textSecondary }]}>{option.label}</Text>
      </TouchableOpacity>
    })}
  </View>
}

let styles = StyleSheet.create({
  group: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 999, padding: Platform.OS === "web" ? 2 : 4 },
  button: { alignItems: "center", justifyContent: "center", minHeight: Platform.OS === "web" ? 28 : 38, paddingHorizontal: Platform.OS === "web" ? 10 : 12, paddingVertical: Platform.OS === "web" ? 2 : 7, borderRadius: 999 },
  compactButton: { minHeight: undefined },
  stretch: { flex: 1 },
  text: { fontSize: 12, fontWeight: "600" },
})
