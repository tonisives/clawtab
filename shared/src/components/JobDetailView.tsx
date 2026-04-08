import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
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
import { PopupMenu } from "./PopupMenu";

const isWeb = Platform.OS === "web";
import type { Transport } from "../transport";
import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { ReadOnlyXterm } from "./ReadOnlyXterm";
import { MessageInput } from "./MessageInput";
import { ParamsDialog } from "./ParamsDialog";
import { AnsiText, hasAnsi } from "./AnsiText";
import { formatTime, formatDuration, compactCron, shortenPath } from "../util/format";
import { nextCronDate, formatNextRun, cronTooltip } from "../util/cron";
import { runStatusColor, runStatusLabel } from "../util/status";
import { collapseSeparators, truncateLogLines } from "../util/logs";
import { isFreetextOption, typeIcon } from "../util/jobs";
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
  /** @deprecated No longer rendered, kept for caller compat */
  onOpen?: () => void;
  onDuplicate?: (group: string) => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
  groups?: string[];
  currentGroup?: string;
  onDuplicateToFolder?: () => void;
  // Hide the back arrow (e.g. when the platform already provides a nav back button)
  showBackButton?: boolean;
  // Hide the path/breadcrumb row at the top of the detail view
  hidePath?: boolean;
  // Auto-expand a specific run by ID (e.g. from notification deep link)
  expandRunId?: string;
  // Slot for platform-specific content (e.g. desktop configuration sections)
  extraContent?: ReactNode;
  // Pre-parsed question options from Rust backend (avoids TS re-parsing)
  options?: { number: string; label: string }[];
  // Context lines from the detected question (shown above option buttons)
  questionContext?: string;
  // Auto-yes support for option buttons
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  // Optional style override for section cards (desktop uses card styling)
  sectionStyle?: import("react-native").StyleProp<import("react-native").ViewStyle>;
  // Hide run history section (e.g. for detected processes)
  hideRuns?: boolean;
  // Expand live output to fill available space (no fixed height)
  expandOutput?: boolean;
  // Optional style override for the container
  containerStyle?: import("react-native").StyleProp<import("react-native").ViewStyle>;
  // Optional style override for the top content area
  contentStyle?: import("react-native").StyleProp<import("react-native").ViewStyle>;
  // Optional breadcrumb shown above the title inside the detail view
  titlePath?: string;
  // Called when log viewer column count changes (for tmux pane resize)
  onLogColumnsChange?: (cols: number) => void;
  // Render a real terminal instead of LogViewer (desktop xterm.js)
  renderTerminal?: () => ReactNode;
  // Hide the message input (when terminal handles input directly)
  hideMessageInput?: boolean;
  // Runtime query info (from detected processes)
  firstQuery?: string;
  lastQuery?: string;
  // Pane actions (desktop only, for running jobs/processes with a tmux pane)
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  // Release the captured tmux pane (desktop only, when viewing a live pane)
  onRelease?: () => void;
  // Notify parent that a stop was requested (for sidebar "Stopping..." state)
  onStopping?: () => void;
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
  onOpen: _onOpen,
  onDuplicate,
  onToggleEnabled,
  onDelete,
  groups,
  currentGroup,
  onDuplicateToFolder,
  showBackButton = true,
  hidePath = false,
  expandRunId,
  extraContent,
  options: optionsProp,
  questionContext,
  autoYesActive,
  onToggleAutoYes,
  sectionStyle,
  hideRuns,
  expandOutput,
  containerStyle,
  contentStyle,
  titlePath,
  onLogColumnsChange,
  renderTerminal,
  hideMessageInput,
  firstQuery,
  lastQuery,
  onFork,
  onSplitPane,
  onInjectSecrets,
  onSearchSkills,
  onRelease,
  onStopping,
}: JobDetailViewProps) {
  const state = status.state;
  const isRunning = state === "running";
  const isPaused = state === "paused";
  const isManual = !job.cron;

  const [runPending, setRunPending] = useState(false);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [runsCollapsed, setRunsCollapsed] = useState(false);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [showDuplicateMenu, setShowDuplicateMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const dupMenuRef = useRef<View>(null);
  const settingsMenuRef = useRef<View>(null);
  const settingsDropdownRef = useRef<View>(null);
  const settingsBtnRef = useRef<any>(null);
  const [zoomRun, setZoomRun] = useState<{ run: RunRecord; logContent: string } | null>(null);
  const [freetextOptionNumber, setFreetextOptionNumber] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [headerWidth, setHeaderWidth] = useState(0);

  const webRefCb = useCallback((_node: HTMLElement | null) => {}, []);

  // Clear run-pending spinner once the job actually starts (or timeout after 1s)
  useEffect(() => {
    if (!runPending) return;
    if (state === "running") { setRunPending(false); return; }
    const timer = setTimeout(() => setRunPending(false), 1000);
    return () => clearTimeout(timer);
  }, [runPending, state]);

  // Reload runs when status changes
  useEffect(() => {
    onReloadRuns?.();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // (outside-click for menus handled by PopupMenu)

  const [sigintPending, setSigintPending] = useState(false);
  const [liveZoom, setLiveZoom] = useState(false);
  const [logsHeight, setLogsHeight] = useState(400);

  const handleLogsResize = useCallback((e: any) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = logsHeight;
    const onMove = (ev: MouseEvent) => {
      setLogsHeight(Math.max(120, startH + (ev.clientY - startY)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [logsHeight]);

  const handleAction = useCallback(
    async (action: "run" | "stop" | "sigint" | "pause" | "resume" | "restart") => {
      if ((action === "run" || action === "restart") && job.params && job.params.length > 0) {
        setShowParamsModal(true);
        return;
      }
      try {
        if (action === "run" || action === "restart") setRunPending(true);
        switch (action) {
          case "run":
            await transport.runJob(job.slug);
            break;
          case "sigint":
            if (transport.sigintJob) {
              setSigintPending(true);
              onStopping?.();
              await transport.sigintJob(job.slug);
              setTimeout(() => setSigintPending(false), 2000);
            }
            break;
          case "stop":
            onStopping?.();
            await transport.stopJob(job.slug);
            break;
          case "pause":
            await transport.pauseJob(job.slug);
            break;
          case "resume":
            await transport.resumeJob(job.slug);
            break;
          case "restart":
            if (transport.restartJob) {
              await transport.restartJob(job.slug);
            } else {
              await transport.runJob(job.slug);
            }
            break;
        }
      } catch (e) {
        setRunPending(false);
        console.error(`Failed to ${action} job:`, e);
      }
    },
    [transport, job.slug, job.params],
  );

  const handleRunWithParams = useCallback(
    async (values: Record<string, string>) => {
      try {
        setRunPending(true);
        await transport.runJob(job.slug, values);
      } catch (e) {
        setRunPending(false);
        console.error("Failed to run job with params:", e);
      }
      setShowParamsModal(false);
    },
    [transport, job.slug],
  );

  const handleSendInput = useCallback(
    async (text: string) => {
      try {
        if (freetextOptionNumber) {
          await transport.sendInput(job.slug, freetextOptionNumber, text);
          setFreetextOptionNumber(null);
        } else {
          await transport.sendInput(job.slug, text);
        }
      } catch (e) {
        console.error("Failed to send input:", e);
      }
    },
    [transport, job.slug, freetextOptionNumber],
  );

  const jobDir = job.work_dir || job.folder_path || "";
  const pathDisplay = jobDir.replace(/^\/Users\/[^/]+/, "~");
  const shortTitlePath = titlePath ? shortenPath(titlePath) : null;
  const compactLeadingPills = headerWidth > 0 && headerWidth < 940;
  const jobTypeIcon = typeIcon(job.job_type);
  const modeLabel = isManual ? (expandOutput ? "detected" : "manual") : job.enabled ? "enabled" : "disabled";
  const modeCompactLabel = isManual ? (expandOutput ? "D" : "M") : job.enabled ? "E" : "X";

  const detailInner = (
    <>
      {/* Header with back button (hidden when platform provides its own nav bar) */}
      {showBackButton && (
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} style={styles.backRow} activeOpacity={0.6}>
            <Text style={styles.backArrow}>{"\u2190"}</Text>
            <Text style={styles.jobName}>{job.name}</Text>
            <StatusBadge status={status} />
          </TouchableOpacity>
        </View>
      )}

      {/* Info row with actions */}
      <View
        style={styles.infoRow}
        onLayout={(e) => setHeaderWidth(e.nativeEvent.layout.width)}
      >
        <View style={styles.infoPills}>
          <View style={[styles.infoPill, compactLeadingPills && styles.infoPillIcon]} {...(isWeb ? { title: job.job_type } as any : {})}>
            {compactLeadingPills ? (
              <Text
                style={[
                  styles.infoLabel,
                  styles.compactInfoLetter,
                  { color: job.job_type === "claude" ? colors.accent : colors.textSecondary },
                ]}
              >
                {jobTypeIcon.letter}
              </Text>
            ) : (
              <Text style={styles.infoLabel}>{job.job_type}</Text>
            )}
          </View>
          {job.cron ? (
            <View style={styles.infoPill} {...(isWeb ? { title: cronTooltip(job.cron) } as any : {})}>
              <Text style={styles.cronText}>{compactCron(job.cron)}</Text>
            </View>
          ) : null}
          {job.cron && job.enabled ? (() => {
            const next = nextCronDate(job.cron);
            return next ? (
              <View style={styles.infoPill}>
                <Text style={styles.nextRunText}>next: {formatNextRun(next)}</Text>
              </View>
            ) : null;
          })() : null}
          {isManual ? (
            <View style={[styles.infoPill, compactLeadingPills && styles.infoPillIcon]} {...(isWeb ? { title: modeLabel } as any : {})}>
              {compactLeadingPills ? (
                <Text style={styles.infoLabel}>{modeCompactLabel}</Text>
              ) : (
                <Text style={styles.infoLabel}>{modeLabel}</Text>
              )}
            </View>
          ) : (
            <View style={[styles.infoPill, compactLeadingPills && styles.infoPillIcon]} {...(isWeb ? { title: modeLabel } as any : {})}>
              <Text style={[styles.infoLabel, { color: job.enabled ? colors.success : colors.textMuted }]}>
                {compactLeadingPills ? modeCompactLabel : modeLabel}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.actions}>
          {isRunning && sigintPending && (
            <ActionButton label="Stopping..." color={colors.danger} onPress={() => {}} disabled compact />
          )}
          {runPending && !isRunning && (
            <ActionButton label="Starting..." color={colors.accent} filled onPress={() => {}} disabled compact />
          )}
          {!runPending && state === "failed" && (
            <ActionButton label="Restart" color={colors.accent} filled onPress={() => handleAction("restart")} compact />
          )}
          {!runPending && state === "success" && (
            <ActionButton label="Run Again" color={colors.accent} filled onPress={() => handleAction("run")} compact />
          )}
          {!runPending && state === "idle" && (
            <ActionButton label="Run" color={colors.accent} filled onPress={() => handleAction("run")} compact />
          )}
          {shortTitlePath ? (
            <Text style={styles.headerPathText} numberOfLines={1}>
              {shortTitlePath}
            </Text>
          ) : null}
          {isRunning && status.started_at ? (
            <Text style={styles.runtimeText}>{formatTime(status.started_at)}</Text>
          ) : null}
          {isRunning && status.pane_id ? (
            <Text style={styles.runtimeDim}>{status.pane_id}</Text>
          ) : null}
          {isRunning && onToggleAutoYes ? (
            <TouchableOpacity
              onPress={onToggleAutoYes}
              activeOpacity={0.6}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 5,
                paddingVertical: 2,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: autoYesActive ? colors.warning : colors.border,
                backgroundColor: autoYesActive ? `${colors.warning}18` : "transparent",
              }}
            >
              <Text style={{ fontSize: 10, color: autoYesActive ? colors.warning : colors.textSecondary, fontWeight: "600" }}>
                Auto-yes
              </Text>
              <View style={{
                width: 20,
                height: 12,
                borderRadius: 6,
                backgroundColor: autoYesActive ? colors.warning : colors.textMuted,
                justifyContent: "center",
                paddingHorizontal: 1,
              }}>
                <View style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: "#fff",
                  alignSelf: autoYesActive ? "flex-end" : "flex-start",
                }} />
              </View>
            </TouchableOpacity>
          ) : null}
          {/* Settings "..." menu */}
          {(onEdit || onDuplicate || onDelete || isRunning || (onToggleEnabled && !isManual) || onFork || onSplitPane || onInjectSecrets || onSearchSkills) && (
            <View ref={settingsMenuRef} style={{ zIndex: 9999, ...(isWeb ? { position: "relative" as const } : {}) }}>
              <TouchableOpacity
                ref={settingsBtnRef}
                style={styles.moreBtn}
                onPress={(e: any) => {
                  if (isWeb) {
                    const node = e?.currentTarget ?? e?.target;
                    if (node?.getBoundingClientRect) {
                      const rect = node.getBoundingClientRect();
                      setMenuPos({ top: rect.bottom + 4, left: rect.right });
                    }
                  }
                  setShowSettingsMenu((v) => !v);
                }}
                activeOpacity={0.6}
              >
                <Text style={styles.moreBtnText}>{"\u2026"}</Text>
              </TouchableOpacity>
              {showSettingsMenu && (
                <PopupMenu
                  dropdownRef={settingsDropdownRef}
                  triggerRef={settingsBtnRef}
                  position={menuPos}
                  onClose={() => setShowSettingsMenu(false)}
                  items={[
                    ...(onEdit ? [{ type: "item" as const, label: "Edit", onPress: () => onEdit() }] : []),
                    ...(onDuplicate ? [{ type: "item" as const, label: "Duplicate", onPress: () => setShowDuplicateMenu(true) }] : []),
                    ...(onToggleEnabled && !isManual ? [{ type: "item" as const, label: job.enabled ? "Disable" : "Enable", onPress: () => onToggleEnabled() }] : []),
                    ...((onFork || onSplitPane || onInjectSecrets || onSearchSkills || onRelease) && (onEdit || onDuplicate || (onToggleEnabled && !isManual)) ? [{ type: "separator" as const }] : []),
                    ...(onFork ? [{ type: "submenu" as const, label: "Fork Session", items: [
                      { type: "item" as const, label: "Right", onPress: () => onFork("right") },
                      { type: "item" as const, label: "Down", onPress: () => onFork("down") },
                    ] }] : []),
                    ...(onSplitPane ? [{ type: "submenu" as const, label: "Split Pane", items: [
                      { type: "item" as const, label: "Right", onPress: () => onSplitPane("right") },
                      { type: "item" as const, label: "Down", onPress: () => onSplitPane("down") },
                    ] }] : []),
                    ...(onInjectSecrets ? [{ type: "item" as const, label: "Inject Secrets", onPress: () => onInjectSecrets() }] : []),
                    ...(onSearchSkills ? [{ type: "item" as const, label: "Send Skill", onPress: () => onSearchSkills() }] : []),
                    ...(onRelease ? [{ type: "item" as const, label: "Release", onPress: () => onRelease() }] : []),
                    ...(isRunning && !sigintPending ? [{ type: "item" as const, label: "Stop", onPress: () => handleAction(transport.sigintJob ? "sigint" : "stop"), color: colors.danger }] : []),
                    ...(onDelete && !isRunning ? [{ type: "separator" as const }, { type: "item" as const, label: "Delete", onPress: () => onDelete(), color: colors.danger }] : []),
                  ]}
                />
              )}
            </View>
          )}
          {/* Close pane "x" button - always last in actions row */}
          {!showBackButton && (
            <TouchableOpacity
              style={styles.moreBtn}
              onPress={onBack}
              activeOpacity={0.6}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.moreBtnText}>{"\u00D7"}</Text>
            </TouchableOpacity>
          )}
          {/* Duplicate sub-menu (shown after selecting Duplicate from settings menu) */}
          {showDuplicateMenu && onDuplicate && (
            <PopupMenu
              dropdownRef={dupMenuRef}
              position={menuPos}
              onClose={() => setShowDuplicateMenu(false)}
              items={[
                ...(groups ?? []).map((g) => ({
                  type: "item" as const,
                  label: g === currentGroup ? `${g} (current)` : g,
                  onPress: () => onDuplicate(g),
                  active: g === currentGroup,
                })),
                ...(onDuplicateToFolder ? [
                  { type: "separator" as const },
                  { type: "item" as const, label: "Choose folder...", onPress: () => onDuplicateToFolder(), color: colors.accent },
                ] : []),
              ]}
            />
          )}
        </View>
      </View>

      {/* Query info for running jobs */}
      {isRunning && firstQuery ? (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Query</Text>
          <Text style={styles.queryLine} numberOfLines={1}>{firstQuery}</Text>
        </View>
      ) : null}
      {isRunning && lastQuery && lastQuery !== firstQuery ? (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Latest</Text>
          <Text style={styles.queryLineDim} numberOfLines={1}>{lastQuery}</Text>
        </View>
      ) : null}

      {/* Live Output */}
      {(isRunning || isPaused) && !expandOutput && (
        <View style={[styles.section, sectionStyle]}>
          <View style={styles.sectionHeaderRow}>
            <TouchableOpacity onPress={() => setOutputCollapsed((v) => !v)} style={styles.sectionHeader} activeOpacity={0.6}>
              <Text style={styles.collapseArrow}>
                {outputCollapsed ? "\u25B6" : "\u25BC"}
              </Text>
              <Text style={styles.sectionTitle}>Live Output</Text>
            </TouchableOpacity>
            {!outputCollapsed && (
              <TouchableOpacity
                onPress={() => setLiveZoom(true)}
                style={styles.zoomBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.zoomIcon}>{"\u2922"}</Text>
              </TouchableOpacity>
            )}
          </View>
          {!outputCollapsed && (
            <>
              {isWeb ? (
                <div style={{ height: logsHeight, overflow: "hidden", position: "relative", display: "flex" }}>
                  {renderTerminal ? renderTerminal() : (
                    <ReadOnlyXterm content={logs} onColumnsChange={onLogColumnsChange} />
                  )}
                </div>
              ) : (
                <View style={[styles.logsContainer, { height: logsHeight }]}>
                  {renderTerminal ? renderTerminal() : (
                    <ReadOnlyXterm content={logs} onColumnsChange={onLogColumnsChange} />
                  )}
                </View>
              )}
              {isWeb && (
                <div
                  onMouseDown={handleLogsResize}
                  style={{
                    height: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "ns-resize",
                    opacity: 0.4,
                    color: colors.textSecondary,
                  }}
                >
                  <svg width="10" height="6" viewBox="0 0 10 6">
                    <path d="M0 1h10M0 4h10" stroke="currentColor" strokeWidth="1" />
                  </svg>
                </div>
              )}
            </>
          )}
          <OptionButtons options={optionsProp ?? []} onSend={handleSendInput} onFreetextOption={setFreetextOptionNumber} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} />
        </View>
      )}

      {/* Run History */}
      {!hideRuns && (
        <View style={[styles.section, sectionStyle]}>
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
                    defaultExpanded={expandRunId ? run.id === expandRunId : (!isRunning && i === 0)}
                    onZoom={(r, content) => setZoomRun({ run: r, logContent: content })}
                  />
                ))
              )}
            </View>
          )}
        </View>
      )}

      {/* Platform-specific extra content */}
      {extraContent}

    </>
  );

  if (expandOutput && (isRunning || isPaused)) {
    return (
      <View style={[styles.container, containerStyle]}>
        {!hidePath && pathDisplay ? (
          <View style={styles.pathRow}>
            <Text style={styles.pathText} numberOfLines={1}>
              {pathDisplay}
            </Text>
          </View>
        ) : null}

        <View style={[styles.content, renderTerminal && { padding: spacing.sm, gap: spacing.sm }, contentStyle]}>
          {detailInner}
        </View>

        <View style={{ flex: 1, minHeight: 0, position: "relative" as const, overflow: "hidden" as const }}>
          {renderTerminal ? renderTerminal() : (
            <ReadOnlyXterm content={logs} borderless onColumnsChange={onLogColumnsChange} />
          )}
          {!renderTerminal && (
            <TouchableOpacity
              onPress={() => setLiveZoom(true)}
              style={styles.zoomOverlay}
              activeOpacity={0.6}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.zoomIcon}>{"\u2922"}</Text>
            </TouchableOpacity>
          )}
        </View>

        <OptionButtons options={optionsProp ?? []} onSend={handleSendInput} onFreetextOption={setFreetextOptionNumber} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} />
        {!hideMessageInput && <MessageInput onSend={handleSendInput} placeholder={freetextOptionNumber ? "Type your answer..." : "Send input to job..."} />}

        {liveZoom && (
          <LiveZoomModal
            logs={logs}
            options={optionsProp ?? []}
            questionContext={questionContext}
            onSend={handleSendInput}
            onFreetextOption={setFreetextOptionNumber}
            freetextOptionNumber={freetextOptionNumber}
            autoYesActive={autoYesActive}
            onToggleAutoYes={onToggleAutoYes}
            onClose={() => setLiveZoom(false)}
          />
        )}
      </View>
    );
  }

  return (
    <View style={[styles.container, containerStyle]}>
      {!hidePath && pathDisplay ? (
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
          <View style={[styles.content, contentStyle]}>
            {detailInner}
          </View>
        </div>
      ) : (
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent} automaticallyAdjustKeyboardInsets>
          <View style={[styles.content, contentStyle]}>
            {detailInner}
          </View>
        </ScrollView>
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

      {/* Fullscreen live output modal */}
      {liveZoom && (
        <LiveZoomModal
          logs={logs}
          options={optionsProp ?? []}
          questionContext={questionContext}
          onSend={handleSendInput}
          onFreetextOption={setFreetextOptionNumber}
          freetextOptionNumber={freetextOptionNumber}
          autoYesActive={autoYesActive}
          onToggleAutoYes={onToggleAutoYes}
          onClose={() => setLiveZoom(false)}
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
  disabled,
  compact,
}: {
  label: string;
  color: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.actionBtn,
        compact && styles.actionBtnCompact,
        filled
          ? { backgroundColor: color }
          : { borderColor: color, borderWidth: 1 },
        disabled ? { opacity: 0.6 } : undefined,
      ]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={disabled ? 1 : 0.7}
      disabled={disabled}
    >
      <Text style={[styles.actionText, compact && styles.actionTextCompact, { color: filled ? "#fff" : color }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// eslint-disable-next-line no-control-regex
const ANSI_RE_STRIP = /\x1b\[[0-9;]*[A-Za-z]/g;

function QuestionContextBlock({ context }: { context?: string }) {
  if (!context) return null;
  const stripped = context.replace(ANSI_RE_STRIP, "").trim();
  if (!stripped) return null;
  return (
    <ScrollView style={styles.questionContext} nestedScrollEnabled>
      <Text style={styles.questionContextText}>{stripped}</Text>
    </ScrollView>
  );
}

function OptionButtons({ options, onSend, onFreetextOption, autoYesActive, onToggleAutoYes }: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
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
          onPress={() => {
            if (isFreetextOption(opt.label) && onFreetextOption) {
              onFreetextOption(opt.number);
            } else {
              onSend(opt.number);
            }
          }}
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

const RunRow = memo(function RunRow({
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

  const logContent = useMemo(
    () => logContentRaw
      ? (isWeb ? collapseSeparators(logContentRaw) : truncateLogLines(collapseSeparators(logContentRaw), 120))
      : null,
    [logContentRaw],
  );

  return (
    <TouchableOpacity onPress={handleToggle} activeOpacity={0.7}>
      <View style={styles.runRow}>
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
})

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
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);

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
        <ReadOnlyXterm content={logContent} borderless />
      </SafeAreaView>
    </Modal>
  );
}

function LiveZoomModal({
  logs,
  options,
  questionContext,
  onSend,
  onFreetextOption,
  freetextOptionNumber,
  autoYesActive,
  onToggleAutoYes,
  onClose,
}: {
  logs: string;
  options: { number: string; label: string }[];
  questionContext?: string;
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
  freetextOptionNumber?: string | null;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.zoomModal}>
        <View style={styles.zoomHeader}>
          <View style={styles.zoomHeaderLeft}>
            <Text style={styles.zoomHeaderLabel}>Live Output</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.zoomCloseBtn} activeOpacity={0.6}>
            <Text style={styles.zoomCloseText}>{"\u2715"}</Text>
          </TouchableOpacity>
        </View>
        <ReadOnlyXterm content={logs} borderless />
        <QuestionContextBlock context={questionContext} />
        <OptionButtons options={options} onSend={onSend} onFreetextOption={onFreetextOption} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} />
        <MessageInput onSend={onSend} placeholder={freetextOptionNumber ? "Type your answer..." : "Send input to job..."} />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    ...(isWeb ? { borderRadius: radius.lg, overflow: "hidden" as const } : {}),
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 200,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    zIndex: 200,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
    minWidth: 0,
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
    paddingVertical: spacing.sm,
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
    justifyContent: "space-between",
    gap: spacing.sm,
    rowGap: spacing.sm,
    flexWrap: "nowrap",
    zIndex: 200,
    ...(isWeb ? { position: "relative" as const } : {}),
  },
  runtimeText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
  },
  headerPathText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
    flex: 1,
    minWidth: 0,
  },
  queryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  queryLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    width: 42,
    flexShrink: 0,
  },
  queryLine: {
    color: colors.textSecondary,
    fontSize: 12,
    flex: 1,
    minWidth: 0,
  },
  queryLineDim: {
    color: colors.textMuted,
    fontSize: 12,
    flex: 1,
    minWidth: 0,
  },
  runtimeDim: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
  },
  infoPills: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "nowrap",
    flexShrink: 0,
  },
  infoPill: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  infoPillIcon: {
    paddingHorizontal: 6,
    minWidth: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  compactInfoLetter: {
    lineHeight: 11,
    letterSpacing: 0,
    textAlign: "center",
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
  nextRunText: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "nowrap",
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  actionBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  actionBtnCompact: {
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
  },
  actionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  actionTextCompact: {
    fontSize: 12,
  },
  section: {
    gap: spacing.sm,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  expandOutputHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logsContainer: {
    // height set dynamically via logsHeight state
    overflow: "hidden" as any,
    // Ensure xterm.js fits within parent width
    position: "relative" as any,
    width: "100%" as any,
  },
  questionContext: {
    backgroundColor: "#111",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 140,
  },
  questionContextText: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
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
  zoomOverlay: {
    position: "absolute",
    top: 8,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
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
  moreBtn: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 12,
  },
});
