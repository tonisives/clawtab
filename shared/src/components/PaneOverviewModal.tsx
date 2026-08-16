import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const MAX_QUERY_CHARS = 640;

export type PaneOverviewData = {
  paneId: string;
  startedAt?: string | null;
  cwd?: string | null;
  tmuxSession?: string | null;
  windowName?: string | null;
  firstQuery?: string | null;
  lastQuery?: string | null;
};

type PaneOverviewModalProps = PaneOverviewData & {
  visible: boolean;
  onClose: () => void;
};

function formatStartedAt(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
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

export function PaneOverviewModal({ visible, onClose, ...pane }: PaneOverviewModalProps) {
  const latestQuery = pane.lastQuery && pane.lastQuery !== pane.firstQuery ? pane.lastQuery : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Pane overview</Text>
              <Text style={styles.subtitle} numberOfLines={1}>{pane.cwd || pane.paneId}</Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close pane overview" hitSlop={8}>
              <Text style={styles.close}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <DetailRow label="Pane" value={pane.paneId} monospace />
            <DetailRow label="Started" value={formatStartedAt(pane.startedAt)} />
            <DetailRow label="Directory" value={pane.cwd ?? "-"} monospace />
            <DetailRow label="Session" value={pane.tmuxSession ?? "-"} monospace />
            <DetailRow label="Window" value={pane.windowName ?? "-"} />
            <QueryBlock label="First query" value={pane.firstQuery} />
            <QueryBlock label="Latest" value={latestQuery} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
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
