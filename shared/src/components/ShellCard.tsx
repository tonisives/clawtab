import { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { ShellPane } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { fitPath, shortenPath } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon } from "./JobKindIcon";

const isWeb = Platform.OS === "web";
type GroupedRowPosition = "single" | "first" | "middle" | "last";

function groupedCardStyle(position?: GroupedRowPosition) {
  if (!isWeb || !position || position === "single") return null;
  if (position === "first") return { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 };
  if (position === "last") return { borderTopLeftRadius: 0, borderTopRightRadius: 0 };
  return { borderRadius: 0 };
}

// Lazily-allocated 2d canvas for sync text measurement on web. Reused across cards.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextPx(text: string, font: string): number {
  if (!isWeb || typeof document === "undefined") return text.length * 7;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function useFittedPath(rawPath: string): { ref: (node: any) => void; text: string } {
  const [text, setText] = useState(() => shortenPath(rawPath));
  const elRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isWeb) {
      setText(shortenPath(rawPath));
      return;
    }
    const el = elRef.current;
    if (!el) return;

    const recompute = () => {
      const width = el.clientWidth;
      if (width <= 0) {
        setText(shortenPath(rawPath));
        return;
      }
      const cs = window.getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      setText(fitPath(rawPath, width, (t) => measureTextPx(t, font)));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rawPath]);

  const ref = (node: any) => {
    elRef.current = node ?? null;
  };
  return { ref, text };
}

export function ShellCard({
  shell,
  onPress,
  selected,
  softBorder,
  onStop,
  onRename,
  renameShortcutHint = "Cmd+R",
  onMoveToWorkspace,
  moveToWorkspaceLabel,
  groupedPosition,
}: {
  shell: ShellPane;
  onPress?: () => void;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  onRename?: () => void;
  renameShortcutHint?: string;
  onMoveToWorkspace?: () => void;
  moveToWorkspaceLabel?: string;
  groupedPosition?: GroupedRowPosition;
}) {
  const explicitName = shell.display_name ?? shell.pane_title ?? null;
  const fitted = useFittedPath(shell.cwd);
  const displayName = explicitName ?? fitted.text;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const canMoveToWorkspace = !!onMoveToWorkspace && !!moveToWorkspaceLabel;
  const showMenu = !!(onStop || onRename || canMoveToWorkspace);

  return (
    <View style={[styles.card, selected ? { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1, boxShadow: "inset 1px 1px 0 rgba(255,255,255,0.1), 1px 1px 0 rgba(0,0,0,0.18)" } : softBorder ? { borderColor: colors.accent + "55", borderWidth: 1 } : null, groupedCardStyle(groupedPosition)]}>
      <TouchableOpacity style={[styles.row, showMenu && styles.rowWithMenu]} onPress={onPress} activeOpacity={0.7}>
        <JobKindIcon kind="shell" />
        <View style={styles.info}>
          <Text ref={explicitName ? undefined : fitted.ref as any} style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Shell pane
          </Text>
        </View>
      </TouchableOpacity>
      {showMenu ? (
        <View style={styles.controlsFrame} pointerEvents="box-none">
          <TouchableOpacity
            ref={menuBtnRef}
            onPress={(e: any) => {
              e.stopPropagation?.();
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
        </View>
      ) : null}
      {menuOpen && showMenu && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            ...(onRename ? [{ type: "item" as const, label: "Rename", hint: renameShortcutHint, onPress: () => { onRename(); setMenuOpen(false); } }] : []),
            ...(canMoveToWorkspace ? [{ type: "item" as const, label: moveToWorkspaceLabel!, onPress: () => { onMoveToWorkspace!(); setMenuOpen(false); } }] : []),
            ...((onRename || canMoveToWorkspace) && onStop ? [{ type: "separator" as const }] : []),
            ...(onStop ? [{ type: "item" as const, label: "Stop", onPress: () => { onStop(); setMenuOpen(false); }, color: colors.danger }] : []),
          ]}
        />
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
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowWithMenu: { paddingRight: 44 },
  info: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: colors.text, fontSize: 16, fontWeight: "500" },
  subtitle: { color: colors.textSecondary, fontSize: 13 },
  controlsFrame: {
    position: "absolute",
    top: 6,
    right: 6,
    height: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  moreBtn: {
    width: 20,
    height: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 18,
    textAlign: "center",
  },
});
