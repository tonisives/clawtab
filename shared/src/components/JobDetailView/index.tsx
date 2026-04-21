import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Platform,
} from "react-native";
import { PopupMenu } from "../PopupMenu";

const isWeb = Platform.OS === "web";
import type { Transport } from "../../transport";
import type { RemoteJob, JobStatus, RunRecord } from "../../types/job";
import type { ProcessProvider, ShellPane } from "../../types/process";
import { StatusBadge } from "../StatusBadge";
import { ReadOnlyXterm } from "../ReadOnlyXterm";
import { MessageInput } from "../MessageInput";
import { ParamsDialog } from "../ParamsDialog";
import { formatTime, compactCron, shortenPath } from "../../util/format";
import { nextCronDate, formatNextRun, cronTooltip } from "../../util/cron";
import { colors } from "../../theme/colors";
import { spacing } from "../../theme/spacing";
import { JobKindIcon, kindForJob, providerKindForJob } from "../JobKindIcon";
import { ActionButton } from "./ActionButton";
import { OptionButtons } from "./Options";
import { RunRow } from "./RunRow";
import { LiveRunZoomOverlay, LogZoomModal, LiveZoomModal } from "./Modals";
import { styles } from "./styles";

function formatTokenCount(value?: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000000) {
    const millions = value / 1000000;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  return `${Math.round(value / 1000)}k`;
}

function tokenCountColor(value?: number | null): string {
  if (typeof value !== "number") return colors.textMuted;
  if (value >= 120000) return "#ff9f0a";
  if (value >= 60000) return "#ffd60a";
  return colors.textMuted;
}

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
  autoYesShortcut?: string;
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
  // Extra left padding applied only to the first header row (e.g. macOS traffic-light inset)
  headerLeftInset?: number;
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
  tokenCount?: number | null;
  onEditTitle?: () => void;
  // Pane actions (desktop only, for running jobs/processes with a tmux pane)
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onZoomPane?: () => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  // Release the captured tmux pane (desktop only, when viewing a live pane)
  onRelease?: () => void;
  // Reveal the current item in the sidebar and scroll to it
  onRevealInSidebar?: () => void;
  // Notify parent that a stop was requested (for sidebar "Stopping..." state)
  onStopping?: () => void;
  // Desktop-only drag handle for split panes
  dragHandleProps?: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown>;
    isDragging?: boolean;
  };
  renderRunTerminal?: (paneId: string, tmuxSession: string) => ReactNode;
  onSplitRunPane?: (paneId: string, direction: "right" | "down") => void;
  defaultAgentProvider?: ProcessProvider;
  extraMenuItems?: { label: string; onPress: () => void }[];
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
  autoYesShortcut,
  sectionStyle,
  hideRuns,
  expandOutput,
  containerStyle,
  contentStyle,
  headerLeftInset,
  titlePath,
  onLogColumnsChange,
  renderTerminal,
  hideMessageInput,
  firstQuery,
  lastQuery,
  tokenCount,
  onEditTitle,
  onFork,
  onSplitPane,
  onZoomPane,
  onInjectSecrets,
  onSearchSkills,
  onRelease,
  onRevealInSidebar,
  onStopping,
  dragHandleProps,
  renderRunTerminal,
  onSplitRunPane,
  defaultAgentProvider = "claude",
  extraMenuItems,
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

  const tokenLabel = formatTokenCount(tokenCount);
  const tokenColor = tokenCountColor(tokenCount);
  const [zoomRun, setZoomRun] = useState<{ run: RunRecord; logContent: string } | null>(null);
  const [liveRunZoom, setLiveRunZoom] = useState<{ run: RunRecord; pane: ShellPane } | null>(null);
  const [freetextOptionNumber, setFreetextOptionNumber] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [headerWidth, setHeaderWidth] = useState(0);

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

  const [sigintPending, setSigintPending] = useState(false);
  const [sigintPendingLabel, setSigintPendingLabel] = useState<"Stopping..." | "Sending C-c...">("Stopping...");
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
              setSigintPendingLabel("Sending C-c...");
              setSigintPending(true);
              await transport.sigintJob(job.slug);
              setTimeout(() => {
                setSigintPending(false);
                setSigintPendingLabel("Stopping...");
              }, 2000);
            }
            break;
          case "stop":
            setSigintPendingLabel("Stopping...");
            setSigintPending(true);
            onStopping?.();
            await transport.stopJob(job.slug);
            setTimeout(() => {
              setSigintPending(false);
              setSigintPendingLabel("Stopping...");
            }, 2000);
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
  const leadingIconSize = compactLeadingPills ? 22 : 28;
  const providerBadgeSize = compactLeadingPills ? 12 : 14;
  const jobTypeIcon = job.cron ? "cron" : kindForJob(job);
  const providerIcon = job.cron ? (providerKindForJob(job) ?? defaultAgentProvider) : null;
  const showModePill = !(isManual && expandOutput);
  const modeLabel = isManual ? (expandOutput ? "detected" : "manual") : job.enabled ? "enabled" : "disabled";
  const modeCompactLabel = isManual ? (expandOutput ? "D" : "M") : job.enabled ? "E" : "X";

  const hasHeaderRow = showBackButton || !!onEditTitle;
  const headerInsetStyle = headerLeftInset ? { paddingLeft: headerLeftInset } : null;
  const detailInner = (
    <>
      {/* Header with back button (hidden when platform provides its own nav bar) */}
      {hasHeaderRow && (
        <View style={[styles.headerRow, headerInsetStyle]}>
          <View style={styles.headerTitleRow}>
            {showBackButton ? (
              <TouchableOpacity onPress={onBack} style={styles.backButton} activeOpacity={0.6}>
                <Text style={styles.backArrow}>{"\u2190"}</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.jobName}>{job.name}</Text>
            <StatusBadge status={status} />
          </View>
          {onEditTitle ? (
            <TouchableOpacity onPress={onEditTitle} activeOpacity={0.6} style={styles.titleEditBtn}>
              <Text style={styles.titleEditText}>Edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {/* Info row with actions */}
      <View
        style={[styles.infoRow, !hasHeaderRow && headerInsetStyle]}
        onLayout={(e) => setHeaderWidth(e.nativeEvent.layout.width)}
      >
        <View style={styles.infoPills}>
          <View
            style={[styles.infoLeadingIcon, { width: leadingIconSize, height: leadingIconSize }]}
            {...(isWeb ? { title: job.cron ? `${job.job_type}: ${providerIcon}` : job.job_type } as any : {})}
          >
            <JobKindIcon kind={jobTypeIcon} size={leadingIconSize} compact bare />
            {providerIcon ? (
              <View style={[styles.infoProviderBadge, { width: providerBadgeSize + 2, height: providerBadgeSize + 2 }]}>
                <JobKindIcon kind={providerIcon} size={providerBadgeSize} compact bare />
              </View>
            ) : null}
          </View>
          {isWeb && dragHandleProps ? (
            <div
              ref={(node) => dragHandleProps.ref?.(node)}
              {...(dragHandleProps.attributes ?? {})}
              {...(dragHandleProps.listeners ?? {})}
              title="Drag pane"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                borderRadius: 6,
                border: `1px solid ${colors.border}`,
                background: colors.surface,
                color: colors.textSecondary,
                cursor: dragHandleProps.isDragging ? "grabbing" : "grab",
                opacity: dragHandleProps.isDragging ? 0.55 : 0.9,
                userSelect: "none",
                touchAction: "none",
                WebkitUserSelect: "none",
              }}
            >
              <span style={{ fontSize: 11, lineHeight: 1, letterSpacing: 1 }}>⋮⋮</span>
            </div>
          ) : null}
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
          {showModePill && isManual ? (
            <View style={[styles.infoPill, compactLeadingPills && styles.infoPillIcon]} {...(isWeb ? { title: modeLabel } as any : {})}>
              {compactLeadingPills ? (
                <Text style={styles.infoLabel}>{modeCompactLabel}</Text>
              ) : (
                <Text style={styles.infoLabel}>{modeLabel}</Text>
              )}
            </View>
          ) : showModePill ? (
            <View style={[styles.infoPill, compactLeadingPills && styles.infoPillIcon]} {...(isWeb ? { title: modeLabel } as any : {})}>
              <Text style={[styles.infoLabel, { color: job.enabled ? colors.success : colors.textMuted }]}>
                {compactLeadingPills ? modeCompactLabel : modeLabel}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actions}>
          {isRunning && sigintPending && (
            <ActionButton label={sigintPendingLabel} color={colors.danger} onPress={() => {}} disabled compact />
          )}
          {runPending && !isRunning && (
            <ActionButton label="Starting..." color={colors.accent} filled onPress={() => {}} disabled compact />
          )}
          {!runPending && state === "failed" && (
            <ActionButton label="Restart" color={colors.accent} filled onPress={() => handleAction("restart")} compact />
          )}
          {!runPending && state === "success" && (
            <ActionButton label="Run Again" color={colors.accent} filled onPress={() => handleAction("run")} compact icon="run" />
          )}
          {!runPending && state === "idle" && (
            <ActionButton label="Run" color={colors.accent} filled onPress={() => handleAction("run")} compact icon="run" />
          )}
          <Text style={styles.headerTitleText} numberOfLines={1}>
            {job.name}
          </Text>
          {isRunning && !!job.cron ? (
            <View
              style={styles.activeRunMarker}
              {...(isWeb ? { title: "Running cron job" } as any : {})}
            >
              <View style={styles.runTriangleMuted} />
            </View>
          ) : null}
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
                Auto-yes{autoYesShortcut ? ` (${autoYesShortcut})` : ""}
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
          {(onEdit || onDuplicate || onDelete || isRunning || (onToggleEnabled && !isManual) || onFork || onSplitPane || onZoomPane || onInjectSecrets || onSearchSkills || onRevealInSidebar) && (
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
                    ...(onToggleEnabled && !isManual ? [{ type: "item" as const, label: job.enabled ? "Disable" : "Enable", onPress: () => onToggleEnabled() }] : []),
                    ...((onFork || onSplitPane || onZoomPane || onInjectSecrets || onSearchSkills || onRelease) && (onEdit || onDuplicate || (onToggleEnabled && !isManual)) ? [{ type: "separator" as const }] : []),
                    ...(onFork ? [{ type: "submenu" as const, label: "Fork Session", items: [
                      { type: "item" as const, label: "Right", onPress: () => onFork("right") },
                      { type: "item" as const, label: "Down", onPress: () => onFork("down") },
                    ] }] : []),
                    ...(onSplitPane ? [{ type: "submenu" as const, label: "Split Pane", items: [
                      { type: "item" as const, label: "Right", hint: "Prefix V", onPress: () => onSplitPane("right") },
                      { type: "item" as const, label: "Down", hint: "Prefix S", onPress: () => onSplitPane("down") },
                    ] }] : []),
                    ...(onZoomPane ? [{ type: "item" as const, label: "Zoom Pane", hint: "Prefix Z", onPress: () => onZoomPane() }] : []),
                    ...(onInjectSecrets ? [{ type: "item" as const, label: "Inject Secrets", onPress: () => onInjectSecrets() }] : []),
                    ...(onSearchSkills ? [{ type: "item" as const, label: "Send Skill", onPress: () => onSearchSkills() }] : []),
                    ...(onRelease ? [{ type: "item" as const, label: "Release", onPress: () => onRelease() }] : []),
                    ...(onRevealInSidebar ? [{ type: "item" as const, label: "Reveal in Sidebar", onPress: () => onRevealInSidebar() }] : []),
                    ...(extraMenuItems?.length ? [{ type: "separator" as const }, ...extraMenuItems.map((it) => ({ type: "item" as const, label: it.label, onPress: it.onPress }))] : []),
                    ...(isRunning && !sigintPending && transport.sigintJob ? [{ type: "item" as const, label: "Send C-c", onPress: () => handleAction("sigint") }] : []),
                    ...(isRunning && !sigintPending ? [{ type: "item" as const, label: "Stop", onPress: () => handleAction("stop"), color: colors.danger }] : []),
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
      {isRunning && (firstQuery || tokenLabel) ? (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Query</Text>
          <Text style={styles.queryLine} numberOfLines={1}>{firstQuery ?? ""}</Text>
          {tokenLabel ? (
            <Text style={[styles.tokenCount, { color: tokenColor }]} numberOfLines={1}>
              {tokenLabel}
            </Text>
          ) : null}
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
          <OptionButtons options={optionsProp ?? []} onSend={handleSendInput} onFreetextOption={setFreetextOptionNumber} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} autoYesShortcut={autoYesShortcut} />
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
                    renderRunTerminal={renderRunTerminal}
                    onSplitRunPane={onSplitRunPane}
                    onOpenLiveRunZoom={(runRecord, pane) => setLiveRunZoom({ run: runRecord, pane })}
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

        <OptionButtons options={optionsProp ?? []} onSend={handleSendInput} onFreetextOption={setFreetextOptionNumber} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} autoYesShortcut={autoYesShortcut} />
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
            autoYesShortcut={autoYesShortcut}
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

      {liveRunZoom && renderRunTerminal && (
        <LiveRunZoomOverlay
          run={liveRunZoom.run}
          pane={liveRunZoom.pane}
          currentState={state}
          renderTerminal={renderRunTerminal}
          onSplitRunPane={onSplitRunPane}
          onClose={() => setLiveRunZoom(null)}
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
