import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { View, Text, TouchableOpacity, ScrollView, Platform } from "react-native";
import type { Transport } from "../../transport";
import type { RunRecord, RunDetail } from "../../types/job";
import type { ShellPane } from "../../types/process";
import { AnsiText, hasAnsi } from "../AnsiText";
import { formatTime, formatDuration, shortenPath } from "../../util/format";
import { runStatusColor, runStatusLabel } from "../../util/status";
import { collapseSeparators, truncateLogLines } from "../../util/logs";
import { colors } from "../../theme/colors";
import { ActionButton } from "./ActionButton";
import { styles } from "./styles";

const isWeb = Platform.OS === "web";

export const RunRow = memo(function RunRow({
  run,
  transport,
  currentState,
  defaultExpanded,
  onZoom,
  renderRunTerminal,
  onOpenLiveRunZoom,
}: {
  run: RunRecord;
  transport: Transport;
  currentState: string;
  defaultExpanded?: boolean;
  onZoom?: (run: RunRecord, logContent: string) => void;
  renderRunTerminal?: (paneId: string, tmuxSession: string) => ReactNode;
  onOpenLiveRunZoom?: (run: RunRecord, pane: ShellPane) => void;
}) {
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [livePane, setLivePane] = useState<ShellPane | null>(null);
  const [paneLookupPending, setPaneLookupPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [sigintPending, setSigintPending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const runWebRef = useRef<HTMLElement | null>(null);
  const paneId = run.pane_id ?? detail?.pane_id ?? null;

  useEffect(() => {
    if (!transport.getExistingPaneInfo || !paneId) {
      setLivePane(null);
      setPaneLookupPending(false);
      return;
    }
    let cancelled = false;
    setPaneLookupPending(true);
    transport.getExistingPaneInfo(paneId)
      .then((pane) => {
        if (!cancelled) setLivePane(pane);
      })
      .catch(() => {
        if (!cancelled) setLivePane(null);
      })
      .finally(() => {
        if (!cancelled) setPaneLookupPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paneId, transport]);

  useEffect(() => {
    if (defaultExpanded && !detail && !loading) {
      setLoading(true);
      transport.getRunDetail(run.id).then((d) => {
        setDetail(d);
        setLoading(false);
      });
    }
  }, [defaultExpanded, run.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const logContentRaw = detail
    ? [detail.stdout, detail.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)"
    : run.stdout || run.stderr
      ? [run.stdout, run.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)"
      : null;

  const logContent = useMemo(
    () => logContentRaw
      ? (isWeb ? collapseSeparators(logContentRaw) : truncateLogLines(collapseSeparators(logContentRaw), 120))
      : null,
    [logContentRaw],
  );

  const hasStoredLogs = !!logContentRaw;
  const isFinishedRun = !!run.finished_at || run.exit_code != null;
  const canLoadStoredLogs = isFinishedRun || hasStoredLogs;
  const canExpand = !!livePane || (!!paneId && paneLookupPending) || canLoadStoredLogs;

  useEffect(() => {
    if (!canExpand && expanded) setExpanded(false);
  }, [canExpand, expanded]);

  const handleToggle = () => {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loading && canLoadStoredLogs) {
      setLoading(true);
      transport.getRunDetail(run.id).then((d) => {
        setDetail(d);
        setLoading(false);
      }).catch((e) => {
        console.error("Failed to load run detail:", e);
        setLoading(false);
      });
    }
  };

  const handleStop = useCallback(async () => {
    try {
      setStopPending(true);
      await transport.stopJob(run.job_id);
    } catch (e) {
      console.error("Failed to stop running pane:", e);
    } finally {
      setTimeout(() => setStopPending(false), 1200);
    }
  }, [run.job_id, transport]);

  const handleSigint = useCallback(async () => {
    if (!transport.sigintJob) return;
    try {
      setSigintPending(true);
      await transport.sigintJob(run.job_id);
    } catch (e) {
      console.error("Failed to send C-c to running pane:", e);
    } finally {
      setTimeout(() => setSigintPending(false), 1200);
    }
  }, [run.job_id, transport]);

  return (
    <View>
      <TouchableOpacity onPress={handleToggle} activeOpacity={canExpand ? 0.7 : 1}>
        <View style={[styles.runRow, expanded && styles.runRowExpanded]}>
          <View style={styles.runLeft}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <View style={styles.runInfo}>
              <Text style={[styles.runStatus, { color }]}>{label}</Text>
              {run.trigger !== "reattach" && (
                <Text style={styles.runTrigger}>{run.trigger}</Text>
              )}
            </View>
          </View>
          <View style={styles.runRight}>
            <View style={styles.runRightRow}>
              <Text style={styles.runTime}>{formatTime(run.started_at)}</Text>
              {livePane && renderRunTerminal ? (
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation();
                    onOpenLiveRunZoom?.(run, livePane);
                  }}
                  style={styles.runPaneLink}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.runPaneLinkText}>Open pane</Text>
                </TouchableOpacity>
              ) : expanded && logContent && onZoom ? (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation(); onZoom(run, logContent); }}
                  style={styles.zoomBtn}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.zoomIcon}>{"\u2922"}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.runDuration}>{duration}</Text>
          </View>
        </View>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.runLogs}>
          {livePane && renderRunTerminal ? (
            <>
              <View style={styles.runTerminalHeader}>
                <View style={styles.runTerminalMeta}>
                  <Text style={styles.runTerminalTitle}>Live shell</Text>
                  <Text style={styles.runTerminalPath} numberOfLines={1}>
                    {shortenPath(livePane.cwd)}
                  </Text>
                </View>
                <View style={styles.runTerminalActions}>
                  {transport.sigintJob ? (
                    <ActionButton
                      label={sigintPending ? "Sending C-c..." : "C-c"}
                      color={colors.warning}
                      onPress={handleSigint}
                      disabled={sigintPending || stopPending}
                      compact
                    />
                  ) : null}
                  <ActionButton
                    label={stopPending ? "Stopping..." : "Stop"}
                    color={colors.danger}
                    onPress={handleStop}
                    disabled={stopPending || sigintPending}
                    compact
                  />
                </View>
              </View>
              <View style={styles.runTerminalBody}>
                {renderRunTerminal(livePane.pane_id, livePane.tmux_session)}
              </View>
            </>
          ) : loading ? (
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
    </View>
  );
});
