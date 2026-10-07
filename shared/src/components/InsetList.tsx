import { Children, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export let InsetList = ({ children }: { children: ReactNode }) => (
  <View style={styles.group}>
    {Children.toArray(children).map((child, index) => <View key={typeof child === "object" && "key" in child ? child.key : String(child)}>
      {index > 0 && <View style={styles.separator} />}
      {child}
    </View>)}
  </View>
);

type InsetListRowProps = {
  title: string;
  description?: string | null;
  accessory?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  disabled?: boolean;
  danger?: boolean;
  selectable?: boolean;
};

export let InsetListRow = ({ title, description, accessory, onPress, chevron = false, disabled = false, danger = false, selectable = false }: InsetListRowProps) => {
  let content = <>
    <View style={styles.text}>
      <Text style={[styles.title, danger && styles.danger]}>{title}</Text>
      {!!description && <Text style={styles.description} selectable={selectable}>{description}</Text>}
    </View>
    {accessory}
    {chevron && <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">›</Text>}
  </>;
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && styles.pressed]}>{content}</Pressable>;
};

let styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: 24, borderCurve: "continuous", overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 18 },
  row: { minHeight: 56, paddingVertical: 16, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 12 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: colors.text, fontSize: 16 },
  description: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  chevron: { color: colors.textMuted, fontSize: 26, lineHeight: 28 },
  danger: { color: colors.danger },
  disabled: { opacity: 0.45 },
  pressed: { backgroundColor: colors.groupedSurface },
});
