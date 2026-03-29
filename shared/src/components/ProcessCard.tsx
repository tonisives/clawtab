import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import type { ClaudeProcess } from "../types/process";
import { shortenPath } from "../util/format";
import { AnsiText, hasAnsi } from "./AnsiText";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function ProcessCard({
  process,
  onPress,
  onSendInput,
}: {
  process: ClaudeProcess;
  onPress?: () => void;
  onSendInput?: (paneId: string, text: string) => void;
}) {
  const displayName = shortenPath(process.cwd);
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  // Defer log rendering to next frame so expand feels instant
  useEffect(() => {
    if (expanded) {
      const id = requestAnimationFrame(() => setShowLogs(true));
      return () => cancelAnimationFrame(id);
    }
    setShowLogs(false);
  }, [expanded]);

  const handleReply = useCallback(() => {
    const text = replyText.trim();
    if (!text || !onSendInput || sending) return;
    setSending(true);
    onSendInput(process.pane_id, text);
    setReplyText("");
    setSending(false);
  }, [replyText, onSendInput, process.pane_id, sending]);

  // Last 3 non-empty log lines for preview
  const logPreview = process.log_lines
    ? process.log_lines.split("\n").filter((l) => l.trim()).slice(-10).join("\n")
    : null;

  const statusWithTitle = (
    <Tooltip label="Running">
      <View style={styles.statusDot} />
    </Tooltip>
  );

  return (
    <View style={styles.processCard}>
      <View style={styles.processRow}>
        <TouchableOpacity
          style={styles.processMain}
          onPress={onPress}
          activeOpacity={0.7}
        >
          <View style={styles.processTypeIcon}>
            <Text style={styles.processTypeIconText}>C</Text>
          </View>
          <View style={styles.processInfo}>
            <Text style={styles.processName} numberOfLines={1}>
              {displayName}
            </Text>
            {!expanded && (
              <Text style={styles.queryPreview} numberOfLines={1}>
                {process.first_query ?? "-"}
              </Text>
            )}
          </View>
          {statusWithTitle}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.chevronBtn}
          onPress={() => setExpanded((v) => !v)}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.chevronText}>{expanded ? "\u25BC" : "\u25B6"}</Text>
        </TouchableOpacity>
      </View>

      {expanded && (
        <View style={styles.details}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Started</Text>
            <Text style={styles.detailValue}>
              {process.session_started_at ?? "-"}
              {"  "}
              <Text style={styles.detailDim}>{process.pane_id}</Text>
            </Text>
          </View>
          {process.first_query && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Query</Text>
              <Text style={styles.detailValue} numberOfLines={4}>{process.first_query}</Text>
            </View>
          )}
          {process.last_query && process.last_query !== process.first_query && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Latest</Text>
              <Text style={styles.detailValue} numberOfLines={4}>{process.last_query}</Text>
            </View>
          )}

          {showLogs && logPreview && (
            <View style={styles.logBox}>
              {hasAnsi(logPreview) ? (
                <AnsiText content={logPreview} style={styles.logText} />
              ) : (
                <Text style={styles.logText} numberOfLines={10}>{logPreview}</Text>
              )}
            </View>
          )}

          {showLogs && onSendInput && (
            <View style={styles.replyRow}>
              <TextInput
                style={styles.replyInput}
                value={replyText}
                onChangeText={setReplyText}
                placeholder="Send input..."
                placeholderTextColor={colors.textMuted}
                onSubmitEditing={handleReply}
                returnKeyType="send"
              />
              <TouchableOpacity
                style={[styles.replyBtn, (!replyText.trim() || sending) && { opacity: 0.4 }]}
                onPress={handleReply}
                disabled={!replyText.trim() || sending}
                activeOpacity={0.6}
              >
                <Text style={styles.replyBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </View>
  );
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
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  processMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, minWidth: 0 },
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
  processName: { color: colors.text, fontSize: 13, fontWeight: "500" },
  queryPreview: {
    color: colors.textMuted,
    fontSize: 11,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusRunning,
    flexShrink: 0,
  },
  chevronBtn: {
    width: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  chevronText: {
    color: colors.textSecondary,
    fontSize: 9,
    fontFamily: "monospace",
  },
  details: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  detailRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    width: 50,
    flexShrink: 0,
  },
  detailValue: {
    color: colors.text,
    fontSize: 11,
    fontFamily: "monospace",
    flex: 1,
  },
  detailDim: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
  },
  logBox: {
    backgroundColor: "#000",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 6,
    marginTop: 2,
    overflow: "hidden",
  },
  logText: {
    color: "#ccc",
    fontSize: 10,
    fontFamily: "monospace",
    lineHeight: 14,
  },
  replyRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 2,
  },
  replyInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: colors.text,
    fontSize: 12,
    fontFamily: "monospace",
    outlineStyle: "none",
  } as any,
  replyBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
  },
  replyBtnText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "600",
  },
});
