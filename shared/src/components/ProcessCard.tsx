import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { DetectedProcess } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { showNativeActionMenu } from "./nativeActionMenu";
import { compactProcessQuery, processDisplayTitle, shortenPath } from "../util/format";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon, kindForProcess } from "./JobKindIcon";

const isWeb = Platform.OS === "web";
type GroupedRowPosition = "single" | "first" | "middle" | "last";

function groupedCardStyle(position?: GroupedRowPosition) {
  if (!isWeb || !position || position === "single") return null;
  if (position === "first") return { backgroundColor: colors.groupedSurface, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 };
  if (position === "last") return { backgroundColor: colors.groupedSurface, borderTopLeftRadius: 0, borderTopRightRadius: 0 };
  return { backgroundColor: colors.groupedSurface, borderRadius: 0 };
}

export function ProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  softBorder,
  onStop,
  onRename,
  onSaveName,
  onTogglePin,
  pinned,
  autoYesActive,
  startRenameSignal,
  onRenameDraftChange,
  onRenameStateChange,
  renameShortcutHint = "Cmd+R",
  onMoveToWorkspace,
  moveToWorkspaceLabel,
  groupedPosition,
}: {
  process: DetectedProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  onRename?: () => void;
  onSaveName?: (name: string) => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  autoYesActive?: boolean;
  startRenameSignal?: number;
  onRenameDraftChange?: (value: string | null) => void;
  onRenameStateChange?: (editing: boolean) => void;
  renameShortcutHint?: string;
  onMoveToWorkspace?: () => void;
  moveToWorkspaceLabel?: string;
  groupedPosition?: GroupedRowPosition;
}) {
  const displayName = processDisplayTitle(process);
  const firstQueryTitle = compactProcessQuery(process.first_query);
  const subtitle = inGroup
    ? (process.last_query && process.last_query !== process.first_query ? process.last_query : null)
    : (displayName !== firstQueryTitle ? process.first_query ?? null : null);

  const transient = process._transient_state;
  const TEN_MINUTES = 10 * 60 * 1000;
  const recentActivity = !transient && (
    !process._last_log_change || (Date.now() - process._last_log_change < TEN_MINUTES)
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const menuBtnRef = useRef<any>(null);
  const editInputRef = useRef<TextInput>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const canRename = !!(onRename || onSaveName) && !transient;

  const startEditing = useCallback(() => {
    if (!canRename) return;
    const initialValue = process.display_name ?? process.pane_title ?? "";
    setEditValue(initialValue);
    setEditing(true);
    setMenuOpen(false);
    onRenameStateChange?.(true);
    onRenameDraftChange?.(initialValue);
    setTimeout(() => { editInputRef.current?.focus(); }, 0);
  }, [canRename, onRenameDraftChange, onRenameStateChange, process.display_name, process.pane_title]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    onRenameStateChange?.(false);
    const trimmed = editValue.trim();
    if (onSaveName) {
      onSaveName(trimmed || (process.display_name ?? ""));
    } else if (onRename) {
      onRename();
    }
    onRenameDraftChange?.(null);
  }, [editValue, onRename, onRenameDraftChange, onRenameStateChange, onSaveName, process.display_name]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    onRenameStateChange?.(false);
    onRenameDraftChange?.(null);
  }, [onRenameDraftChange, onRenameStateChange]);

  const lastStartRenameSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (startRenameSignal === lastStartRenameSignalRef.current) return;
    lastStartRenameSignalRef.current = startRenameSignal;
    if (typeof startRenameSignal === "number" && startRenameSignal > 0) {
      startEditing();
    }
  }, [startEditing, startRenameSignal]);

  useEffect(() => {
    if (!editing || !isWeb) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const input = editInputRef.current as unknown as HTMLElement | null;
      if (input?.contains(event.target as Node)) return;
      cancelEdit();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
    };
  }, [cancelEdit, editing]);

  const statusDot = transient ? (
    <View style={[
      styles.statusDot,
      transient === "starting" ? styles.statusDotStarting : styles.statusDotStopping,
    ]} />
  ) : (
    <Tooltip label={recentActivity ? "Running" : "Idle"}>
      <View style={[styles.statusDot, !recentActivity && styles.statusDotIdle]} />
    </Tooltip>
  );

  const canMoveToWorkspace = !!onMoveToWorkspace && !!moveToWorkspaceLabel && !transient;
  const showMenu = (onStop || onRename || onSaveName || onTogglePin || canMoveToWorkspace) && !transient;
  const kind = kindForProcess(process);
  const openMenu = useCallback((e?: any) => {
    if (!showMenu || editing) return;
    if (!isWeb) {
      showNativeActionMenu([
        ...(onTogglePin ? [{ label: pinned ? "Unpin" : "Pin", onPress: onTogglePin }] : []),
        ...(canRename ? [{ label: "Rename", onPress: startEditing }] : []),
        ...(canMoveToWorkspace ? [{ label: moveToWorkspaceLabel!, onPress: onMoveToWorkspace! }] : []),
        ...(onStop ? [{ label: "Stop", onPress: onStop, destructive: true }] : []),
      ]);
      return;
    }
    if (isWeb) {
      const node = e?.currentTarget ?? e?.target;
      if (node?.getBoundingClientRect) {
        const rect = node.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.right });
      }
    } else if (e?.nativeEvent) {
      setMenuPos({
        top: (e.nativeEvent.pageY ?? 44) + 6,
        left: e.nativeEvent.pageX ?? 12,
      });
    }
    setMenuOpen(true);
  }, [canMoveToWorkspace, canRename, editing, moveToWorkspaceLabel, onMoveToWorkspace, onStop, onTogglePin, pinned, showMenu, startEditing]);

  return (
    <View style={[styles.processCard, selected ? { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1, boxShadow: "inset 1px 1px 0 rgba(255,255,255,0.1), 1px 1px 0 rgba(0,0,0,0.18)" } : softBorder ? { borderColor: colors.accent + "55", borderWidth: 1 } : null, groupedCardStyle(groupedPosition)]}>
      <TouchableOpacity
        style={styles.processRow}
        onPress={editing ? undefined : onPress}
        onLongPress={openMenu}
        activeOpacity={0.7}
      >
        <JobKindIcon kind={kind} />
        <View style={styles.processInfo}>
          {editing ? (
            <TextInput
              ref={editInputRef}
              value={editValue}
              onChangeText={(value) => {
                setEditValue(value);
                onRenameDraftChange?.(value);
              }}
              onSubmitEditing={commitEdit}
              onBlur={cancelEdit}
              onKeyPress={(e: any) => {
                if (e?.key === "Escape") cancelEdit();
              }}
              style={styles.editInput}
              placeholder={shortenPath(process.cwd)}
              placeholderTextColor={colors.textMuted}
              selectTextOnFocus
            />
          ) : (
            <Text style={[styles.processName, transient === "stopping" && { opacity: 0.5 }]} numberOfLines={1}>
              {displayName}
            </Text>
          )}
          {!editing && (transient ? (
            <Text style={[styles.queryPreview, { fontStyle: "italic" }]} numberOfLines={1}>
              {transient === "starting" ? "Starting..." : "Stopping..."}
            </Text>
          ) : subtitle ? (
            <Text style={styles.queryPreview} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null)}
        </View>
        <View style={[styles.rightCol, (showMenu || (autoYesActive && !transient)) && styles.rightColExpanded]}>
          {showMenu && !editing ? (
            <TouchableOpacity
              ref={menuBtnRef}
              onPress={(e: any) => {
                e.stopPropagation();
                if (menuOpen) setMenuOpen(false);
                else openMenu(e);
              }}
              style={styles.moreBtn}
              activeOpacity={0.6}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.moreBtnText}>{"\u2026"}</Text>
            </TouchableOpacity>
          ) : (autoYesActive && !transient) ? <View style={styles.spacer} /> : null}
          {statusDot}
          {autoYesActive && !transient ? (
            <View style={styles.autoYesDot} />
          ) : showMenu ? <View style={styles.spacer} /> : null}
        </View>
      </TouchableOpacity>
      {isWeb && menuOpen && (onStop || onRename || onSaveName || onTogglePin || canMoveToWorkspace) && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            ...(onTogglePin ? [{ type: "item" as const, label: pinned ? "Unpin" : "Pin", onPress: () => { onTogglePin(); setMenuOpen(false); } }] : []),
            ...(onTogglePin && (canRename || canMoveToWorkspace || onStop) ? [{ type: "separator" as const }] : []),
            ...(canRename ? [{ type: "item" as const, label: "Rename", hint: renameShortcutHint, onPress: () => { startEditing(); } }] : []),
            ...(canMoveToWorkspace ? [{ type: "item" as const, label: moveToWorkspaceLabel!, onPress: () => { onMoveToWorkspace!(); setMenuOpen(false); } }] : []),
            ...((canRename || canMoveToWorkspace) && onStop ? [{ type: "separator" as const }] : []),
            ...(onStop ? [{ type: "item" as const, label: "Stop", onPress: () => { onStop(); setMenuOpen(false); }, color: colors.danger }] : []),
          ]}
        />
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
    ...(Platform.OS !== "web"
      ? {
          borderRadius: 0,
          borderWidth: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
          opacity: 1,
          paddingVertical: spacing.lg,
        }
      : {}),
  },
  processCardSelected: {
    borderColor: colors.accent,
    opacity: 1,
  },
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  processInfo: { flex: 1, gap: 2, minWidth: 0 },
  processName: { color: colors.text, fontSize: 16, fontWeight: "500", flexShrink: 1 },
  editInput: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "500",
    padding: 0,
    margin: 0,
    borderWidth: 0,
    outlineStyle: "none" as any,
    backgroundColor: "transparent",
    minWidth: 0,
  },
  queryPreview: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusRunning,
    flexShrink: 0,
  },
  statusDotStarting: {
    backgroundColor: colors.accent,
    opacity: 0.5,
  },
  statusDotStopping: {
    backgroundColor: colors.textMuted,
    opacity: 0.5,
  },
  statusDotIdle: {
    backgroundColor: colors.statusIdle,
  },
  rightCol: {
    alignItems: "center",
    justifyContent: "center",
    height: 32,
  },
  rightColExpanded: {
    justifyContent: "space-between",
    height: 44,
    marginTop: -10,
    marginBottom: -3,
    marginRight: -6,
  },
  spacer: {
    height: 8,
  },
  autoYesDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warning,
  },
  moreBtn: {
    width: 20,
    height: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 14,
  },
});
