import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { compactPath, formatTime, timeAgo } from "../util/format";

const MAX_QUERY_CHARS = 640;

export type PaneOverviewData = {
  paneId: string;
  startedAt?: string | null;
  cwd?: string | null;
  tmuxSession?: string | null;
  firstQuery?: string | null;
  lastQuery?: string | null;
};

export type PaneOverviewActions = {
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onStart?: () => void;
  starting?: boolean;
};

type PaneOverviewModalProps = PaneOverviewData & {
  visible: boolean;
  onClose: () => void;
  actions?: PaneOverviewActions;
};

function formatStartedAt(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${formatTime(value)} (${timeAgo(value)})` : value;
}

function limitQuery(value?: string | null): string {
  const query = value?.trim() ?? "";
  if (!query) return "-";
  if (query.length <= MAX_QUERY_CHARS) return query;
  const side = Math.floor((MAX_QUERY_CHARS - 7) / 2);
  return `${query.slice(0, side).trimEnd()}\n...\n${query.slice(-side).trimStart()}`;
}

function DetailRow({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, monospace && styles.monospace]} selectable>
        {value || "-"}
      </Text>
    </View>
  );
}

function QueryBlock({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null;
  return (
    <View style={styles.queryBlock}>
      <Text style={styles.queryLabel}>{label}</Text>
      <Text style={styles.queryValue} selectable>{limitQuery(value)}</Text>
    </View>
  );
}

export function PaneOverviewModal({ visible, onClose, actions, ...pane }: PaneOverviewModalProps) {
  const latestQuery = pane.lastQuery && pane.lastQuery !== pane.firstQuery ? pane.lastQuery : null;
  const title = pane.cwd ? compactPath(pane.cwd) : "Pane overview";

  const content = (
    <View style={styles.root}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            <View style={styles.headerMeta}>
              <Text style={styles.sessionTitle} numberOfLines={1}>{pane.tmuxSession || "-"}</Text>
              <Text style={styles.metaSeparator}>·</Text>
              <Text style={styles.paneIdTitle} numberOfLines={1}>{pane.paneId}</Text>
            </View>
          </View>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close pane overview"
            hitSlop={8}
          >
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {(actions?.onToggleAutoYes || actions?.onTogglePin || actions?.onStop || actions?.onStart) ? (
            <View style={styles.actions}>
              <View style={styles.toggleGroup}>
                {actions.onToggleAutoYes ? (
                  <View style={styles.toggleAction}>
                    <Text style={styles.toggleLabel}>Auto Yes</Text>
                    <Switch
                      value={!!actions.autoYesActive}
                      onValueChange={actions.onToggleAutoYes}
                      trackColor={{ false: colors.borderLight, true: colors.accent }}
                      thumbColor={colors.surface}
                      ios_backgroundColor={colors.borderLight}
                      accessibilityLabel="Auto Yes"
                    />
                  </View>
                ) : null}
                {actions.onTogglePin ? (
                  <View style={styles.toggleAction}>
                    <Text style={styles.toggleLabel}>Pin</Text>
                    <Switch
                      value={!!actions.isPinned}
                      onValueChange={actions.onTogglePin}
                      trackColor={{ false: colors.borderLight, true: colors.accent }}
                      thumbColor={colors.surface}
                      ios_backgroundColor={colors.borderLight}
                      accessibilityLabel="Pin pane"
                    />
                  </View>
                ) : null}
              </View>
              {actions.onStop ? (
                <Pressable
                  style={[styles.endActionButton, styles.stopButton]}
                  onPress={actions.onStop}
                  disabled={actions.stopping}
                  accessibilityRole="button"
                  accessibilityLabel="Stop process"
                >
                  <Text style={[styles.actionText, styles.stopText]}>
                    {actions.stopping ? "Stopping..." : "Stop"}
                  </Text>
                </Pressable>
              ) : actions.onStart ? (
                <Pressable
                  style={[styles.endActionButton, styles.startButton]}
                  onPress={actions.onStart}
                  disabled={actions.starting}
                  accessibilityRole="button"
                  accessibilityLabel="Start process"
                >
                  <Text style={[styles.actionText, styles.startText]}>
                    {actions.starting ? "Starting..." : "Start"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <DetailRow label="Started" value={formatStartedAt(pane.startedAt)} />
          <QueryBlock label="First query" value={pane.firstQuery} />
          <QueryBlock label="Latest query" value={latestQuery} />
        </ScrollView>
      </View>
    </View>
  );

  // Native detail screens can already be presented inside a native-stack modal
  // (for example, notification details). Avoid nesting another RN Modal there;
  // on iOS Fabric that can repeatedly remount the modal host and hit React's
  // maximum update-depth guard. The in-screen overlay has the same visual and
  // interaction behavior without creating a second native presentation.
  if (Platform.OS !== "web") {
    if (!visible) return null;
    return <View style={styles.nativeRoot}>{content}</View>;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create({
  nativeRoot: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    elevation: 1000,
  },
  root: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "86%",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  headerMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    maxWidth: "52%",
    flexShrink: 0,
  },
  sessionTitle: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
  },
  metaSeparator: {
    color: colors.textMuted,
    fontSize: 11,
  },
  paneIdTitle: {
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: "monospace",
  },
  closeButton: {
    minHeight: 32,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: spacing.md,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.xs,
  },
  toggleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flexShrink: 1,
  },
  toggleAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 34,
    flexShrink: 1,
  },
  toggleLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  endActionButton: {
    minHeight: 34,
    minWidth: 58,
    marginLeft: "auto",
    paddingHorizontal: spacing.md,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bg,
  },
  stopButton: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerBg,
  },
  startButton: {
    borderColor: colors.success,
    backgroundColor: colors.successBg,
  },
  actionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  stopText: {
    color: colors.danger,
  },
  startText: {
    color: colors.success,
  },
  close: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  scroll: {
    flexGrow: 0,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  detailLabel: {
    width: 78,
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  detailValue: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 12,
  },
  monospace: {
    fontFamily: "monospace",
  },
  queryBlock: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  queryLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  queryValue: {
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 12,
    lineHeight: 18,
  },
});
