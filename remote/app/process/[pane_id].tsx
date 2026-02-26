import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useJobsStore } from "../../src/store/jobs";
import { LogViewer } from "../../src/components/LogViewer";
import { MessageInput } from "../../src/components/MessageInput";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { confirm } from "../../src/lib/platform";
import { parseNumberedOptions } from "../../src/components/ProcessCard";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

function BackButton() {
  const router = useRouter();
  return (
    <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.6}>
      <Ionicons name="chevron-back" size={22} color={colors.text} />
      <Text style={styles.backText}>Jobs</Text>
    </TouchableOpacity>
  );
}

export default function ProcessDetailScreen() {
  const { pane_id } = useLocalSearchParams<{ pane_id: string }>();
  const process = useJobsStore((s) => s.detectedProcesses.find((p) => p.pane_id === pane_id));
  const lastProcessRef = useRef(process);
  if (process) lastProcessRef.current = process;
  const lastProcess = lastProcessRef.current;
  const { isWide } = useResponsive();
  const [logs, setLogs] = useState(process?.log_lines ?? "");
  const [stopping, setStopping] = useState(false);

  const displayName = (process ?? lastProcess)
    ? (process ?? lastProcess)!.cwd.replace(/^\/Users\/[^/]+/, "~")
    : pane_id;

  // Poll logs - use lastProcess as fallback for tmux_session
  const activeProcess = process ?? lastProcess;
  useEffect(() => {
    if (!activeProcess) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const send = getWsSend();
        if (!send) return;
        const id = nextId();
        send({
          type: "get_detected_process_logs",
          id,
          tmux_session: activeProcess.tmux_session,
          pane_id: activeProcess.pane_id,
        });
        const timeout = new Promise<{ logs?: string }>((resolve) =>
          setTimeout(() => resolve({}), 5000),
        );
        const resp = await Promise.race([registerRequest<{ logs?: string }>(id), timeout]);
        if (active && resp.logs != null) setLogs(resp.logs.trimEnd());
      } finally {
        polling = false;
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeProcess?.pane_id, activeProcess?.tmux_session]);

  const options = useMemo(() => parseNumberedOptions(logs), [logs]);

  const handleSend = useCallback(
    (text: string) => {
      const proc = process ?? lastProcess;
      if (!proc) return;
      const send = getWsSend();
      if (send && text.trim()) {
        send({
          type: "send_detected_process_input",
          id: nextId(),
          pane_id: proc.pane_id,
          text: text.trim(),
        });
      }
    },
    [process?.pane_id],
  );

  const doStop = async () => {
    const proc = process ?? lastProcess;
    if (!proc) return;
    const send = getWsSend();
    if (!send || stopping) return;
    setStopping(true);
    const id = nextId();
    send({ type: "stop_detected_process", id, pane_id: proc.pane_id });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([registerRequest(id), timeout]);
    setStopping(false);
  };

  const handleStop = () => {
    confirm("Stop process", `Kill the Claude process in ${displayName}?`, doStop);
  };

  const isAlive = !!process;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: displayName,
          headerLeft: () => <BackButton />,
          headerRight: () => (
            <View style={styles.headerRight}>
              <View style={isAlive ? styles.runningBadge : styles.endedBadge}>
                <Text style={isAlive ? styles.runningText : styles.endedText}>
                  {isAlive ? "running" : "ended"}
                </Text>
              </View>
            </View>
          ),
        }}
      />

      {(process ?? lastProcess) && (
        <View style={styles.pathRow}>
          <Text style={styles.pathText} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.versionText}>v{(process ?? lastProcess)!.version}</Text>
        </View>
      )}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ContentContainer wide>
          <View style={[styles.content, isWide && styles.contentWide]}>
            {isAlive && (
              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.stopBtn, stopping && { opacity: 0.5 }]}
                  onPress={handleStop}
                  disabled={stopping}
                  activeOpacity={0.7}
                >
                  <Text style={styles.stopBtnText}>{stopping ? "Stopping..." : "Stop"}</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.logsContainer}>
              <LogViewer content={logs} />
            </View>
          </View>
        </ContentContainer>
      </ScrollView>

      {isAlive && <OptionButtons options={options} onSend={handleSend} />}
      {isAlive && <MessageInput onSend={handleSend} placeholder="Send input..." />}
    </View>
  );
}

function OptionButtons({
  options,
  onSend,
}: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.optionBar}
      contentContainerStyle={styles.optionBarContent}
    >
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.number}
          style={styles.optionBtn}
          onPress={() => onSend(opt.number)}
          activeOpacity={0.6}
        >
          <Text style={styles.optionBtnText}>
            {opt.number}. {opt.label.length > 25 ? opt.label.slice(0, 25) + "..." : opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: { padding: spacing.lg, gap: spacing.lg, flex: 1 },
  contentWide: { paddingTop: 32, paddingHorizontal: spacing.xl },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  notFound: { color: colors.textMuted, fontSize: 16 },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: -8,
  },
  backText: {
    color: colors.text,
    fontSize: 16,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginRight: 4 },
  runningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  runningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },
  endedBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: "rgba(152, 152, 157, 0.12)",
  },
  endedText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.textMuted },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pathText: { flex: 1, color: colors.textMuted, fontSize: 11, fontFamily: "monospace" },
  versionText: { color: colors.textSecondary, fontSize: 11 },
  actions: { flexDirection: "row", gap: spacing.sm },
  stopBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  stopBtnText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  logsContainer: { flex: 1, minHeight: 300 },
  optionBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    maxHeight: 44,
  },
  optionBarContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: "center",
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
});
