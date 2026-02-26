import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Modal } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useJob, useJobStatus } from "../../src/store/jobs";
import { useRuns, useRunsStore } from "../../src/store/runs";
import { StatusBadge } from "../../src/components/StatusBadge";
import { LogViewer } from "../../src/components/LogViewer";
import { MessageInput } from "../../src/components/MessageInput";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { useLogs } from "../../src/hooks/useLogs";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { formatTime, formatDuration } from "../../src/lib/format";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";
import type { RunDetail, RunRecord } from "../../src/types/job";

export default function JobDetailScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const job = useJob(name);
  const status = useJobStatus(name);
  const { logs } = useLogs(name);
  const runs = useRuns(name);
  const { isWide } = useResponsive();
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [runsCollapsed, setRunsCollapsed] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);

  // Fetch run history
  const loadRuns = useCallback(() => {
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(name, result);
      setRunsLoading(false);
    });
  }, [name]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Reload runs when status changes (a run finished or started)
  useEffect(() => {
    loadRuns();
  }, [status.state]);

  const [showParamsModal, setShowParamsModal] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const handleAction = useCallback(
    (action: "run_job" | "pause_job" | "resume_job" | "stop_job") => {
      if (action === "run_job" && job?.params && job.params.length > 0) {
        const values: Record<string, string> = {};
        for (const p of job.params) values[p] = "";
        setParamValues(values);
        setShowParamsModal(true);
        return;
      }
      const send = getWsSend();
      if (send) {
        send({ type: action, id: nextId(), name });
      }
    },
    [name, job],
  );

  const handleRunWithParams = useCallback(() => {
    const send = getWsSend();
    if (send) {
      send({ type: "run_job", id: nextId(), name, params: paramValues });
    }
    setShowParamsModal(false);
  }, [name, paramValues]);

  const handleSendInput = useCallback(
    (text: string) => {
      const send = getWsSend();
      if (send) {
        send({ type: "send_input", id: nextId(), name, text });
      }
    },
    [name],
  );

  if (!job) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: name }} />
        <View style={styles.center}>
          <Text style={styles.notFound}>Job not found</Text>
        </View>
      </View>
    );
  }

  const state = status.state;
  const isRunning = state === "running";
  const isPaused = state === "paused";

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => <StatusBadge status={status} />,
        }}
      />

      {/* Path subtitle */}
      {(job.work_dir || job.path) ? (
        <View style={styles.pathRow}>
          <Text style={styles.pathText} numberOfLines={1}>
            {(job.work_dir || job.path || "").replace(/^\/Users\/[^/]+/, "~")}
          </Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ContentContainer wide>
          <View style={[styles.content, isWide && styles.contentWide]}>
            {/* Info row */}
            <View style={styles.infoRow}>
              <View style={styles.infoPill}>
                <Text style={styles.infoLabel}>{job.job_type}</Text>
              </View>
              {job.cron ? (
                <View style={styles.infoPill}>
                  <Text style={styles.cronText}>{job.cron}</Text>
                </View>
              ) : null}
              <View style={styles.infoPill}>
                <Text style={[styles.infoLabel, { color: job.enabled ? colors.success : colors.textMuted }]}>
                  {job.enabled ? "Enabled" : "Disabled"}
                </Text>
              </View>
            </View>

            {/* Action buttons */}
            <View style={styles.actions}>
              {isRunning && (
                <>
                  <ActionButton label="Pause" color={colors.warning} onPress={() => handleAction("pause_job")} />
                  <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop_job")} />
                </>
              )}
              {isPaused && (
                <>
                  <ActionButton label="Resume" color={colors.success} filled onPress={() => handleAction("resume_job")} />
                  <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop_job")} />
                </>
              )}
              {state === "failed" && (
                <ActionButton label="Restart" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
              {state === "success" && (
                <ActionButton label="Run Again" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
              {state === "idle" && (
                <ActionButton label="Run" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
            </View>

            {/* Live Output - only when running/paused */}
            {(isRunning || isPaused) && (
              <View style={styles.section}>
                <TouchableOpacity onPress={() => setOutputCollapsed((v) => !v)} style={styles.sectionHeader} activeOpacity={0.6}>
                  <Text style={styles.collapseArrow}>
                    {outputCollapsed ? "\u25B6" : "\u25BC"}
                  </Text>
                  <Text style={styles.sectionTitle}>Live Output</Text>
                </TouchableOpacity>
                {!outputCollapsed && (
                  <View style={styles.logsContainer}>
                    <LogViewer content={logs} />
                  </View>
                )}
              </View>
            )}

            {/* Run History - collapsible */}
            <View style={styles.section}>
              <TouchableOpacity onPress={() => setRunsCollapsed((v) => !v)} style={styles.sectionHeader} activeOpacity={0.6}>
                <Text style={styles.collapseArrow}>
                  {runsCollapsed ? "\u25B6" : "\u25BC"}
                </Text>
                <Text style={styles.sectionTitle}>Runs</Text>
              </TouchableOpacity>
              {!runsCollapsed && (
                <View style={styles.runsContainer}>
                  {runsLoading && !runs ? (
                    <Text style={styles.runsEmpty}>Loading...</Text>
                  ) : !runs || runs.length === 0 ? (
                    <Text style={styles.runsEmpty}>No run history</Text>
                  ) : (
                    runs.map((run, i) => (
                      <RunRow key={run.id} run={run} currentState={state} defaultExpanded={i === 0} />
                    ))
                  )}
                </View>
              )}
            </View>
          </View>
        </ContentContainer>
      </ScrollView>

      {(isRunning || isPaused) && (
        <>
          <OptionButtons logs={logs} onSend={handleSendInput} />
          <MessageInput onSend={handleSendInput} placeholder="Send input to job..." />
        </>
      )}

      <Modal visible={showParamsModal} transparent animationType="fade" onRequestClose={() => setShowParamsModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Run: {job?.name}</Text>
            <Text style={styles.modalHint}>Fill in all parameters before running.</Text>
            {job?.params?.map((key) => (
              <View key={key} style={styles.paramRow}>
                <Text style={styles.paramLabel}>{key}</Text>
                <TextInput
                  style={styles.paramInput}
                  value={paramValues[key] ?? ""}
                  onChangeText={(text) => setParamValues((prev) => ({ ...prev, [key]: text }))}
                  placeholder={`{${key}}`}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ))}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setShowParamsModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalRunBtn, (job?.params?.some((k) => !paramValues[k]?.trim())) && { opacity: 0.4 }]}
                onPress={handleRunWithParams}
                disabled={job?.params?.some((k) => !paramValues[k]?.trim())}
              >
                <Text style={styles.modalRunText}>Run</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function parseNumberedOptions(text: string): { number: string; label: string }[] {
  const lines = text.split("\n").slice(-20);
  const options: { number: string; label: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^[\s>›»❯▸▶]*(\d+)\.\s+(.+)/);
    if (match) {
      options.push({ number: match[1], label: match[2].trim() });
    }
  }
  return options;
}

function OptionButtons({ logs, onSend }: { logs: string; onSend: (text: string) => void }) {
  const options = useMemo(() => parseNumberedOptions(logs), [logs]);
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

function ActionButton({
  label,
  color,
  onPress,
  filled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  filled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.actionBtn,
        filled
          ? { backgroundColor: color }
          : { borderColor: color, borderWidth: 1 },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.actionText, { color: filled ? "#fff" : color }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function RunRow({ run, currentState, defaultExpanded }: { run: RunRecord; currentState: string; defaultExpanded?: boolean }) {
  const statusColor = getRunStatusColor(run, currentState);
  const statusLabel = getRunStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-load detail for default expanded
  useEffect(() => {
    if (defaultExpanded && !detail && !loading) {
      setLoading(true);
      const send = getWsSend();
      if (send) {
        const id = nextId();
        send({ type: "get_run_detail", id, run_id: run.id });
        registerRequest<{ detail?: RunDetail }>(id).then((resp) => {
          setDetail(resp.detail ?? null);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }
  }, [defaultExpanded, run.id]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loading) {
      setLoading(true);
      const send = getWsSend();
      if (send) {
        const id = nextId();
        send({ type: "get_run_detail", id, run_id: run.id });
        registerRequest<{ detail?: RunDetail }>(id).then((resp) => {
          setDetail(resp.detail ?? null);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }
  };

  const logContent = detail
    ? [detail.stdout, detail.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)"
    : null;

  return (
    <TouchableOpacity onPress={handleToggle} activeOpacity={0.7}>
      <View style={styles.runRow}>
        <View style={styles.runLeft}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <View style={styles.runInfo}>
            <Text style={[styles.runStatus, { color: statusColor }]}>{statusLabel}</Text>
            <Text style={styles.runTrigger}>{run.trigger}</Text>
          </View>
        </View>
        <View style={styles.runRight}>
          <Text style={styles.runTime}>{formatTime(run.started_at)}</Text>
          <Text style={styles.runDuration}>{duration}</Text>
        </View>
      </View>
      {expanded && (
        <View style={styles.runLogs}>
          {loading ? (
            <Text style={styles.runLogsText}>Loading...</Text>
          ) : logContent ? (
            <ScrollView horizontal={false} style={{ maxHeight: 300 }} nestedScrollEnabled>
              <Text style={styles.runLogsText} selectable>{logContent}</Text>
            </ScrollView>
          ) : (
            <Text style={styles.runLogsText}>(no output)</Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function getRunStatusColor(run: RunRecord, currentState: string): string {
  if (run.exit_code == null) {
    if (run.finished_at || currentState !== "running") return colors.danger;
    return colors.statusRunning;
  }
  if (run.exit_code === 0) return colors.success;
  return colors.danger;
}

function getRunStatusLabel(run: RunRecord, currentState: string): string {
  if (run.exit_code == null) {
    if (run.finished_at || currentState !== "running") return "interrupted";
    return "running";
  }
  if (run.exit_code === 0) return "ok";
  return `exit ${run.exit_code}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  contentWide: {
    paddingTop: 32,
    paddingHorizontal: spacing.xl,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  notFound: {
    color: colors.textMuted,
    fontSize: 16,
  },
  pathRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pathText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  infoPill: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  infoLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: "600",
  },
  cronText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  actionBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  actionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  section: {
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  collapseArrow: {
    fontFamily: "monospace",
    fontSize: 9,
    color: colors.textSecondary,
  },
  logsContainer: {
    height: 400,
  },
  runsContainer: {
    gap: 1,
  },
  runsEmpty: {
    color: colors.textMuted,
    fontSize: 12,
    paddingVertical: spacing.sm,
  },
  runRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    marginBottom: 2,
  },
  runLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  runInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  runStatus: {
    fontSize: 12,
    fontWeight: "500",
  },
  runTrigger: {
    fontSize: 12,
    color: colors.textMuted,
  },
  runRight: {
    alignItems: "flex-end",
  },
  runTime: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  runDuration: {
    fontSize: 11,
    color: colors.textMuted,
  },
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
  optionBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  runLogs: {
    padding: spacing.sm,
    backgroundColor: "#000",
    borderRadius: radius.sm,
    marginTop: 4,
    marginBottom: 2,
  },
  runLogsText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
    lineHeight: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    width: "100%",
    maxWidth: 400,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  modalHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 16,
  },
  paramRow: {
    marginBottom: 12,
  },
  paramLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 4,
  },
  paramInput: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: "monospace",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: 8,
  },
  modalCancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  modalRunBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  modalRunText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});
