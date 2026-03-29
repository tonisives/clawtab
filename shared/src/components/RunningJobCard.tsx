import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import type { JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { AnsiText, hasAnsi } from "./AnsiText";
import { formatTime, timeAgo, shortenPath } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function RunningJobCard({
  jobName,
  jobSlug,
  status,
  workDir,
  onPress,
  onSendInput,
  onSubscribeLogs,
}: {
  jobName: string;
  jobSlug: string;
  status: JobStatus;
  workDir?: string;
  onPress?: () => void;
  onSendInput?: (slug: string, text: string) => void;
  onSubscribeLogs?: (slug: string, onChunk: (content: string) => void) => () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [logContent, setLogContent] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const subscribeRef = useRef(onSubscribeLogs);
  subscribeRef.current = onSubscribeLogs;
  const sendInputRef = useRef(onSendInput);
  sendInputRef.current = onSendInput;

  // Subscribe to logs when expanded
  useEffect(() => {
    if (!expanded || !subscribeRef.current) return;
    const unsub = subscribeRef.current(jobSlug, (chunk) => {
      if (chunk.startsWith("\x00")) {
        setLogContent(chunk.slice(1));
      } else {
        setLogContent((prev) => prev + chunk);
      }
    });
    return () => unsub();
  }, [expanded, jobSlug]);

  const handleReply = useCallback(() => {
    const text = replyText.trim();
    if (!text || !onSendInput || sending) return;
    setSending(true);
    onSendInput(jobSlug, text);
    setReplyText("");
    setSending(false);
  }, [replyText, onSendInput, jobSlug, sending]);

  const startedAt = status.state === "running" ? status.started_at : null;
  const paneId = status.state === "running" ? (status as { pane_id?: string }).pane_id : null;

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <TouchableOpacity
          style={styles.row}
          onPress={onPress}
          activeOpacity={0.7}
        >
          <View style={styles.typeIcon}>
            <Text style={styles.typeIconText}>C</Text>
          </View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>{jobName}</Text>
            {!expanded && startedAt && (
              <Text style={styles.metaText}>{timeAgo(startedAt)}</Text>
            )}
          </View>
          <StatusBadge status={{ state: "running", started_at: "", run_id: "" }} />
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
          {startedAt && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Started</Text>
              <Text style={styles.detailValue}>
                {formatTime(startedAt)}
                {paneId ? (
                  <>{"  "}<Text style={styles.detailDim}>{paneId}</Text></>
                ) : null}
              </Text>
            </View>
          )}
          {workDir && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Path</Text>
              <Text style={styles.detailValue} numberOfLines={1}>{shortenPath(workDir)}</Text>
            </View>
          )}

          {logContent ? (() => {
            const preview = logContent.split("\n").filter((l) => l.trim()).slice(-10).join("\n");
            return preview ? (
              <View style={styles.logBox}>
                {hasAnsi(preview) ? (
                  <AnsiText content={preview} style={styles.logText} />
                ) : (
                  <Text style={styles.logText} numberOfLines={10}>{preview}</Text>
                )}
              </View>
            ) : null;
          })() : null}

          {onSendInput && (
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  row: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, minWidth: 0 },
  typeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  typeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  info: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  metaText: { color: colors.textSecondary, fontSize: 12 },
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
