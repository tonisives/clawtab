import { useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet, Modal } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "../theme/colors"
import { radius, spacing } from "../theme/spacing"
import type { ClaudeProcess } from "../types/job"

function InfoPopup({ process, onClose }: { process: ClaudeProcess; onClose: () => void }) {
  const displayName = process.cwd.replace(/^\/Users\/[^/]+/, "~")

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.modalCard} activeOpacity={1} onPress={() => {}}>
          <View style={styles.popupContent}>
            <View style={styles.popupHeader}>
              <View style={styles.popupHeaderLeft}>
                <View style={styles.popupIcon}>
                  <Text style={styles.popupIconText}>C</Text>
                </View>
                <View style={{ gap: 1 }}>
                  <Text style={styles.popupTitle}>{displayName}</Text>
                  <Text style={styles.popupSubtitle}>v{process.version}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.popupClose} activeOpacity={0.6}>
                <Text style={styles.popupCloseText}>x</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.popupDivider} />

            <View style={styles.popupGrid}>
              <View style={styles.popupGridItem}>
                <Text style={styles.popupLabel}>Pane ID</Text>
                <Text style={styles.popupMono}>{process.pane_id}</Text>
              </View>
              {process.session_started_at && (
                <View style={styles.popupGridItem}>
                  <Text style={styles.popupLabel}>Started</Text>
                  <Text style={styles.popupMono}>{process.session_started_at}</Text>
                </View>
              )}
            </View>

            {process.first_query && (
              <View style={styles.popupSection}>
                <Text style={styles.popupLabel}>First query</Text>
                <View style={styles.popupQueryBox}>
                  <Text style={styles.popupQueryText} numberOfLines={6}>{process.first_query}</Text>
                </View>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  )
}

export function ProcessCard({
  process,
}: {
  process: ClaudeProcess
}) {
  const router = useRouter()
  const displayName = process.cwd.replace(/^\/Users\/[^/]+/, "~")
  const [showPopup, setShowPopup] = useState(false)

  return (
    <>
      <TouchableOpacity
        style={styles.processCard}
        onPress={() => router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)}
        activeOpacity={0.7}
      >
        <View style={styles.processRow}>
          <View style={styles.processTypeIcon}>
            <Text style={styles.processTypeIconText}>C</Text>
          </View>
          <View style={styles.processInfo}>
            <Text style={styles.processName} numberOfLines={1}>
              {displayName}
            </Text>
            <View style={styles.processMeta}>
              <Text style={styles.processMetaText}>v{process.version}</Text>
              {process.first_query && (
                <Text style={styles.queryPreview} numberOfLines={1}>
                  {process.first_query}
                </Text>
              )}
            </View>
          </View>
          <TouchableOpacity
            style={styles.eyeBtn}
            onPress={() => setShowPopup(true)}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.eyeBtnText}>{"\u25C9"}</Text>
          </TouchableOpacity>
          <View style={styles.processRunningBadge}>
            <Text style={styles.processRunningText}>running</Text>
          </View>
        </View>
      </TouchableOpacity>

      {showPopup && (
        <InfoPopup process={process} onClose={() => setShowPopup(false)} />
      )}
    </>
  )
}

const styles = StyleSheet.create({
  processCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.7,
  },
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  processTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  processTypeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
    fontStyle: "italic",
  },
  processInfo: { flex: 1, gap: 2, minWidth: 0 },
  processName: { color: colors.text, fontSize: 15, fontWeight: "500", fontStyle: "italic" },
  processMeta: { flexDirection: "row", gap: spacing.sm, alignItems: "center", minWidth: 0 },
  processMetaText: { color: colors.textSecondary, fontSize: 12, flexShrink: 0 },
  queryPreview: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
    minWidth: 0,
  },
  eyeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  eyeBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  processRunningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  processRunningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    minWidth: 300,
    maxWidth: 480,
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.4,
    shadowRadius: 48,
    elevation: 24,
  },
  popupContent: { gap: 12 },
  popupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  popupHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  popupIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  popupIconText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: "monospace",
    fontStyle: "italic",
  },
  popupTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  popupSubtitle: { color: colors.textSecondary, fontSize: 11 },
  popupClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.bg,
    justifyContent: "center",
    alignItems: "center",
  },
  popupCloseText: { color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
  popupDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  popupGrid: {
    flexDirection: "row",
    gap: 16,
  },
  popupGridItem: { gap: 2 },
  popupLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  popupMono: {
    color: colors.text,
    fontSize: 13,
    fontFamily: "monospace",
  },
  popupSection: { gap: 4 },
  popupQueryBox: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
  },
  popupQueryText: {
    color: colors.text,
    fontSize: 12,
    fontFamily: "monospace",
    lineHeight: 18,
  },
})
