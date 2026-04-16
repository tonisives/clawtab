import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { DetectedProcess } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { shortenPath } from "../util/format";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon, kindForProcess } from "./JobKindIcon";

const isWeb = Platform.OS === "web";

export function ProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  onStop,
  onRename,
  onSaveName,
  autoYesActive,
  startRenameSignal,
  onRenameDraftChange,
  onRenameStateChange,
  renameShortcutHint = "Cmd+R",
}: {
  process: DetectedProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  onStop?: () => void;
  onRename?: () => void;
  onSaveName?: (name: string) => void;
  autoYesActive?: boolean;
  startRenameSignal?: number;
  onRenameDraftChange?: (value: string | null) => void;
  onRenameStateChange?: (editing: boolean) => void;
  renameShortcutHint?: string;
}) {
  const displayName = inGroup
    ? (process.display_name ?? process.pane_title ?? process.first_query ?? shortenPath(process.cwd))
    : (process.display_name ?? process.pane_title ?? shortenPath(process.cwd));

  const subtitle = inGroup
    ? (process.last_query && process.last_query !== process.first_query ? process.last_query : null)
    : (process.first_query ?? null);

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

  const showMenu = (onStop || onRename || onSaveName) && !transient;
  const kind = kindForProcess(process);

  return (
    <View style={[styles.processCard, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1 }]}>
      <TouchableOpacity
        style={styles.processRow}
        onPress={editing ? undefined : onPress}
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
                if (isWeb) {
                  const node = e?.currentTarget ?? e?.target;
                  if (node?.getBoundingClientRect) {
                    const rect = node.getBoundingClientRect();
                    setMenuPos({ top: rect.bottom + 4, left: rect.right });
                  }
                }
                setMenuOpen((v) => !v);
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
      {menuOpen && (onStop || onRename || onSaveName) && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            ...(canRename ? [{ type: "item" as const, label: "Rename", hint: renameShortcutHint, onPress: () => { startEditing(); } }] : []),
            ...(canRename && onStop ? [{ type: "separator" as const }] : []),
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
  },
  processCardSelected: {
    borderColor: colors.accent,
    opacity: 1,
  },
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  processInfo: { flex: 1, gap: 2, minWidth: 0 },
  processName: { color: colors.text, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  editInput: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
    padding: 0,
    margin: 0,
    borderWidth: 0,
    outlineStyle: "none" as any,
    backgroundColor: "transparent",
    minWidth: 0,
  },
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
    height: 50,
    marginTop: -13,
    marginBottom: -5,
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
