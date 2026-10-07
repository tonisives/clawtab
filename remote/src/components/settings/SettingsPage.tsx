import type { ReactNode } from "react"
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { ContentContainer } from "../ContentContainer"
import { useResponsive } from "../../hooks/useResponsive"
import { colors } from "../../theme/colors"
import { radius, spacing } from "../../theme/spacing"

export let SettingsPage = ({ children }: { children: ReactNode }) => {
  let { isIosPadPortrait } = useResponsive()
  return <ScrollView style={styles.scrollContainer} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.pageContent, isIosPadPortrait && styles.pageContentPad]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <ContentContainer><View style={styles.container}>{children}</View></ContentContainer>
  </ScrollView>
}
export let SettingsRow = ({ title, detail, onPress, disabled = false }: { title: string; detail?: string; onPress: () => void; disabled?: boolean }) => <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} style={({ pressed }) => [styles.row, (pressed || disabled) && styles.pressed]}>
  <View style={styles.rowText}><Text style={styles.rowTitle}>{title}</Text>{detail && <Text style={styles.rowDetail}>{detail}</Text>}</View>
  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
</Pressable>
export let styles = StyleSheet.create({
  pageContent: { flexGrow: 1, paddingBottom: 32 },
  pageContentPad: { paddingBottom: 110 },
  rowText: { flex: 1, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 16 },
  rowDetail: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.65 },
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.xl,
  },
  cacheDescription: { color: colors.textSecondary, marginBottom: 12 },
  section: {
    gap: spacing.md,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  listGroup: {
    borderRadius: 24,
    borderCurve: "continuous",
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  row: {
    minHeight: 56,
    gap: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  value: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
    maxWidth: "60%",
  },
  usageRefresh: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  disabledText: {
    color: colors.textMuted,
  },
  usageDescription: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  usageCards: {
    gap: spacing.sm,
  },
  usageCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  usageCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  usageCardTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  usageCardStatus: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  usageUnavailable: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  usageNote: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  usageEmptyCard: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  usageEmptyText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnConstrained: {
    alignSelf: "flex-start",
    width: 220,
  },
  dangerBtn: {
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.danger,
    justifyContent: "center",
    alignItems: "center",
  },
  dangerText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "600",
  },
  dangerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  dangerToggleText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  deleteBtn: {
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.danger,
    justifyContent: "center",
    alignItems: "center",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  deleteBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
})
