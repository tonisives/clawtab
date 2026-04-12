import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { ShellPane } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { shortenPath } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon } from "./JobKindIcon";

const isWeb = Platform.OS === "web";

export function ShellCard({
  shell,
  onPress,
  selected,
  onStop,
  onRename,
}: {
  shell: ShellPane;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
  onRename?: () => void;
}) {
  const displayName = shell.display_name ?? shortenPath(shell.cwd);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const showMenu = !!(onStop || onRename);

  return (
    <View style={[styles.card, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1 }]}>
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <JobKindIcon kind="shell" />
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Shell pane
          </Text>
        </View>
        {showMenu ? (
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
        ) : null}
      </TouchableOpacity>
      {menuOpen && showMenu && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            ...(onRename ? [{ type: "item" as const, label: "Rename", hint: "Cmd+R", onPress: () => { onRename(); setMenuOpen(false); } }] : []),
            ...(onRename && onStop ? [{ type: "separator" as const }] : []),
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
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  info: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: colors.text, fontSize: 13, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 11 },
  moreBtn: {
    width: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: -4,
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 14,
  },
});
