import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  SafeAreaView,
  Platform,
} from "react-native";

const isWeb = Platform.OS === "web";
import type { Transport } from "../transport";
import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { LogViewer } from "./LogViewer";
import { MessageInput } from "./MessageInput";
import { ParamsDialog } from "./ParamsDialog";
import { AnsiText, hasAnsi } from "./AnsiText";
import { formatTime, formatDuration } from "../util/format";
import { runStatusColor, runStatusLabel } from "../util/status";
import { parseNumberedOptions } from "../util/jobs";
import { collapseSeparators, truncateLogLines } from "../util/logs";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export interface JobDetailViewProps {
  transport: Transport;
  job: RemoteJob;
  status: JobStatus;
  logs: string;
  runs: RunRecord[] | null;
  runsLoading?: boolean;
  onBack: () => void;
  onReloadRuns?: () => void;
  // Desktop-only slots
  onEdit?: () => void;
  onOpen?: () => void;
  onDuplicate?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
  // Auto-expand a specific run by ID (e.g. from notification deep link)
  expandRunId?: string;
  // Slot for platform-specific content (e.g. desktop configuration sections)
  extraContent?: ReactNode;
  // Auto-yes support for option buttons
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
}

export function JobDetailView({
  transport,
  job,
  status,
  logs,
  runs,
  runsLoading,
  onBack,
  onReloadRuns,
  onEdit,
  onOpen,
  onDuplicate,
  onToggleEnabled,
  onDelete,
  expandRunId,
  extraContent,
  autoYesActive,
  onToggleAutoYes,
}: JobDetailViewProps) {
  const state = status.state;
  const isRunning = state === "running";
  const isPaused = state === "paused";

  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [runsCollapsed, setRunsCollapsed] = useState(false);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [zoomRun, setZoomRun] = useState<{ run: RunRecord; logContent: string } | null>(null);
  // Scroll to bottom when new logs arrive
  const scrollRef = useRef<ScrollView>(null);
  const webDivRef = useRef<HTMLElement | null>(null);
  const prevLogsLen = useRef(0);

  const webRefCb = useCallback((node: HTMLElement | null) => {
    webDivRef.current = node;
  }, []);

  useEffect(() => {
    if (!isRunning || outputCollapsed) return;
    // Only scroll when content actually grows
    if (logs.length <= prevLogsLen.current) {
      prevLogsLen.current = logs.length;
      return;
    }
    prevLogsLen.current = logs.length;

    if (isWeb) {
      const el = webDivRef.current as any;
      if (!el) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
    } else {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [logs, isRunning, outputCollapsed]);

  // Reload runs when status changes
  useEffect(() => {
    onReloadRuns?.();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = useCallback(
    async (action: "run" | "stop" | "pause" | "resume" | "restart") => {
      if ((action === "run" || action === "restart") && job.params && job.params.length > 0) {
        setShowParamsModal(true);
        return;
      }
      try {
        switch (action) {
          case "run":
            await transport.runJob(job.name);
            break;
          case "stop":
            await transport.stopJob(job.name);
            break;
          case "pause":
            await transport.pauseJob(job.name);
            break;
          case "resume":
            await transport.resumeJob(job.name);
            break;
          case "restart":
            if (transport.restartJob) {
              await transport.restartJob(job.name);
            } else {
              await transport.runJob(job.name);
            }
            break;
        }
      } catch (e) {
        console.error(`Failed to ${action} job:`, e);
      }
    },
    [transport, job.name, job.params],
  );

  const handleRunWithParams = useCallback(
    async (values: Record<string, string>) => {
      try {
        await transport.runJob(job.name, values);
      } catch (e) {
        console.error("Failed to run job with params:", e);
      }
      setShowParamsModal(false);
    },
    [transport, job.name],
  );

  const handleSendInput = useCallback(
    async (text: string) => {
      try {
        await transport.sendInput(job.name, text);
      } catch (e) {
        console.error("Failed to send input:", e);
      }
    },
    [transport, job.name],
  );

  const pathDisplay = (job.work_dir || job.path || "").replace(/^\/Users\/[^/]+/, "~");

  const detailInner = (
    <>
      {/* Header with back button */}
      <TouchableOpacity onPress={onBack} style={styles.backRow} activeOpacity={0.6}>
        <Text style={styles.backArrow}>{"\u2190"}</Text>
        <Text style={styles.jobName}>{job.name}</Text>
        <StatusBadge status={status} />
      </TouchableOpacity>

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
            {onOpen && <ActionButton label="Open" color={colors.accent} onPress={() => onOpen()} />}
            <ActionButton label="Pause" color={colors.warning} onPress={() => handleAction("pause")} />
            <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop")} />
          </>
        )}
        {isPaused && (
          <>
            <ActionButton label="Resume" color={colors.success} filled onPress={() => handleAction("resume")} />
            <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop")} />
          </>
        )}
        {state === "failed" && (
          <ActionButton label="Restart" color={colors.accent} filled onPress={() => handleAction("restart")} />
        )}
        {state === "success" && (
          <ActionButton label="Run Again" color={colors.accent} filled onPress={() => handleAction("run")} />
        )}
        {state === "idle" && (
          <ActionButton label="Run" color={colors.accent} filled onPress={() => handleAction("run")} />
        )}
        {onEdit && <ActionButton label="Edit" color={colors.textSecondary} onPress={onEdit} />}
      </View>

      {/* Live Output */}
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

      {/* Run History */}
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
                <RunRow
                  key={run.id}
                  run={run}
                  transport={transport}
                  currentState={state}
                  defaultExpanded={expandRunId ? run.id === expandRunId : i === 0}
                  onZoom={(r, content) => setZoomRun({ run: r, logContent: content })}
                />
              ))
            )}
          </View>
        )}
      </View>

      {/* Platform-specific extra content */}
      {extraContent}

      {/* Danger zone (desktop-only) */}
      {(onToggleEnabled || onDuplicate || onDelete) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions</Text>
          <View style={styles.actions}>
            {onToggleEnabled && (
              <ActionButton
                label={job.enabled ? "Disable" : "Enable"}
                color={colors.textSecondary}
                onPress={onToggleEnabled}
              />
            )}
            {onDuplicate && (
              <ActionButton label="Duplicate" color={colors.textSecondary} onPress={onDuplicate} />
            )}
            {onDelete && (
              <ActionButton label="Delete" color={colors.danger} onPress={onDelete} />
            )}
          </View>
        </View>
      )}
    </>
  );

  return (
    <View style={styles.container}>
      {/* Path subtitle */}
      {pathDisplay ? (
        <View style={styles.pathRow}>
          <Text style={styles.pathText} numberOfLines={1}>
            {pathDisplay}
          </Text>
        </View>
      ) : null}

      {isWeb ? (
        <div
          ref={webRefCb as any}
          style={{
            flex: 1,
            overflowY: "auto" as any,
            minHeight: 0,
          }}
        >
          <View style={styles.content}>
            {detailInner}
          </View>
        </div>
      ) : (
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.content}>
            {detailInner}
          </View>
        </ScrollView>
      )}

      {/* Input bar when running/paused */}
      {(isRunning || isPaused) && (
        <>
          <OptionButtons logs={logs} onSend={handleSendInput} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} />
          <MessageInput onSend={handleSendInput} placeholder="Send input to job..." />
        </>
      )}

      {/* Params modal */}
      {job.params && job.params.length > 0 && (
        <ParamsDialog
          jobName={job.name}
          params={job.params}
          visible={showParamsModal}
          onRun={handleRunWithParams}
          onCancel={() => setShowParamsModal(false)}
        />
      )}

      {/* Fullscreen log zoom modal */}
      {zoomRun && (
        <LogZoomModal
          run={zoomRun.run}
          logContent={zoomRun.logContent}
          currentState={state}
          onClose={() => setZoomRun(null)}
        />
      )}
    </View>
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

function OptionButtons({ logs, onSend, autoYesActive, onToggleAutoYes }: {
  logs: string;
  onSend: (text: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
}) {
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
      {onToggleAutoYes && (
        <>
          <View style={styles.optionSeparator} />
          <TouchableOpacity
            style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
            onPress={onToggleAutoYes}
            activeOpacity={0.6}
          >
            <Text style={styles.autoYesBtnText} numberOfLines={1}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

function RunRow({
  run,
  transport,
  currentState,
  defaultExpanded,
  onZoom,
}: {
  run: RunRecord;
  transport: Transport;
  currentState: string;
  defaultExpanded?: boolean;
  onZoom?: (run: RunRecord, logContent: string) => void;
}) {
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const runWebRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (defaultExpanded && !detail && !loading) {
      setLoading(true);
      transport.getRunDetail(run.id).then((d) => {
        setDetail(d);
        setLoading(false);
      });
    }
  }, [defaultExpanded, run.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when log content loads
  useEffect(() => {
    if (!expanded || !detail) return;
    if (isWeb) {
      const el = runWebRef.current as any;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    } else if (scrollRef.current) {
      const timer = setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [expanded, detail]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loading) {
      setLoading(true);
      transport.getRunDetail(run.id).then((d) => {
        setDetail(d);
        setLoading(false);
      });
    }
  };

  const logContentRaw = detail
    ? [detail.stdout, detail.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)"
    : run.stdout || run.stderr
      ? [run.stdout, run.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)"
      : null;

  const logContent = logContentRaw
    ? (isWeb ? collapseSeparators(logContentRaw) : truncateLogLines(collapseSeparators(logContentRaw), 120))
    : null;

  return (
    <TouchableOpacity onPress={handleToggle} activeOpacity={0.7}>
      <View style={styles.runRow}>
        <View style={styles.runLeft}>
          <View style={[styles.statusDot, { backgroundColor: color }]} />
          <View style={styles.runInfo}>
            <Text style={[styles.runStatus, { color }]}>{label}</Text>
            <Text style={styles.runTrigger}>{run.trigger}</Text>
          </View>
        </View>
        <View style={styles.runRight}>
          <View style={styles.runRightRow}>
            <Text style={styles.runTime}>{formatTime(run.started_at)}</Text>
            {expanded && logContent && onZoom && (
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation(); onZoom(run, logContent); }}
                style={styles.zoomBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.zoomIcon}>{"\u2922"}</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.runDuration}>{duration}</Text>
        </View>
      </View>
      {expanded && (
        <View style={styles.runLogs}>
          {loading ? (
            <Text style={styles.runLogsText}>Loading...</Text>
          ) : logContent ? (
            isWeb ? (
              <div
                ref={(node: HTMLElement | null) => { runWebRef.current = node; }}
                style={{ maxHeight: 300, overflowY: "auto" as any }}
              >
                {hasAnsi(logContent) ? (
                  <AnsiText content={logContent} style={styles.runLogsText} selectable />
                ) : (
                  <Text style={styles.runLogsText} selectable>{logContent}</Text>
                )}
              </div>
            ) : (
              <ScrollView ref={scrollRef} horizontal={false} style={{ maxHeight: 300 }} nestedScrollEnabled>
                {hasAnsi(logContent) ? (
                  <AnsiText content={logContent} style={styles.runLogsText} selectable />
                ) : (
                  <Text style={styles.runLogsText} selectable>{logContent}</Text>
                )}
              </ScrollView>
            )
          ) : (
            <Text style={styles.runLogsText}>(no output)</Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function LogZoomModal({
  run,
  logContent,
  currentState,
  onClose,
}: {
  run: RunRecord;
  logContent: string;
  currentState: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const zoomWebRef = useRef<HTMLElement | null>(null);
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);

  const zoomWebRefCb = useCallback((node: HTMLElement | null) => {
    zoomWebRef.current = node;
    if (node) {
      requestAnimationFrame(() => {
        (node as any).scrollTop = (node as any).scrollHeight;
      });
    }
  }, []);

  useEffect(() => {
    if (!isWeb) {
      const timer = setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []);

  const logInner = hasAnsi(logContent) ? (
    <AnsiText content={logContent} style={styles.zoomLogText} selectable />
  ) : (
    <Text style={styles.zoomLogText} selectable>{logContent}</Text>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.zoomModal}>
        <View style={styles.zoomHeader}>
          <View style={styles.zoomHeaderLeft}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <Text style={styles.zoomHeaderLabel}>{label}</Text>
            <Text style={styles.zoomHeaderTime}>{formatTime(run.started_at)}</Text>
            <Text style={styles.zoomHeaderDuration}>{duration}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.zoomCloseBtn} activeOpacity={0.6}>
            <Text style={styles.zoomCloseText}>{"\u2715"}</Text>
          </TouchableOpacity>
        </View>
        {isWeb ? (
          <div
            ref={zoomWebRefCb as any}
            style={{
              flex: 1,
              overflowY: "auto" as any,
              padding: 16,
              minHeight: 0,
            }}
          >
            {logInner}
          </div>
        ) : (
          <ScrollView ref={scrollRef} style={styles.zoomLogScroll} contentContainerStyle={styles.zoomLogContent}>
            {logInner}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
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
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  backArrow: {
    color: colors.textSecondary,
    fontSize: 18,
    lineHeight: 22,
    textAlign: "center",
    width: 22,
    height: 22,
  },
  jobName: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
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
  optionSeparator: {
    width: 1,
    height: 18,
    backgroundColor: colors.border,
  },
  autoYesBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  autoYesBtnActive: {
    backgroundColor: colors.warningBg,
  },
  autoYesBtnText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
  },
  runRightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  zoomBtn: {
    padding: 6,
  },
  zoomIcon: {
    color: colors.textMuted,
    fontSize: 18,
    fontFamily: "monospace",
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
  zoomModal: {
    flex: 1,
    backgroundColor: "#000",
  },
  zoomHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  zoomHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  zoomHeaderLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  zoomHeaderTime: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  zoomHeaderDuration: {
    color: colors.textMuted,
    fontSize: 11,
  },
  zoomCloseBtn: {
    padding: spacing.sm,
  },
  zoomCloseText: {
    color: colors.textSecondary,
    fontSize: 18,
  },
  zoomLogScroll: {
    flex: 1,
  },
  zoomLogContent: {
    padding: spacing.md,
  },
  zoomLogText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: "monospace",
    lineHeight: 18,
  },
});
