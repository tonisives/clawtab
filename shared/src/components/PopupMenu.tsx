import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";
import { spacing, radius } from "../theme/spacing";

const isWeb = Platform.OS === "web";

let createPortalFn: ((children: ReactNode, container: Element) => ReactNode) | null = null;
if (isWeb) {
  import("react-dom").then((mod) => { createPortalFn = mod.createPortal; });
}

function PortalWeb({ children }: { children: ReactNode }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (isWeb && !createPortalFn) {
      import("react-dom").then((mod) => {
        createPortalFn = mod.createPortal;
        forceUpdate((n) => n + 1);
      });
    }
  }, []);
  if (!isWeb || !createPortalFn) return <>{children}</>;
  return createPortalFn(children, document.body);
}

export type PopupMenuItem =
  | { type: "item"; label: string; onPress: () => void; color?: string; active?: boolean }
  | { type: "separator" }
  | { type: "submenu"; label: string; items: PopupMenuItem[] };

interface PopupMenuProps {
  items: PopupMenuItem[];
  position?: { top: number; left: number } | null;
  onClose: () => void;
  dropdownRef?: React.RefObject<View | null>;
  /** Ref to the trigger button - clicks on it are ignored so the button's own toggle works */
  triggerRef?: React.RefObject<any>;
}

function HoverableItem({ item, onPress }: {
  item: Extract<PopupMenuItem, { type: "item" }> | Extract<PopupMenuItem, { type: "submenu" }>;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const webProps = isWeb ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  const isSubmenu = item.type === "submenu";
  const color = item.type === "item" ? item.color : undefined;
  const active = item.type === "item" ? item.active : false;

  return (
    <TouchableOpacity
      style={[
        styles.item,
        active && styles.itemActive,
        hovered && styles.itemHover,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webProps}
    >
      <View style={styles.itemRow}>
        <Text style={[
          styles.itemText,
          active && styles.itemTextActive,
          color ? { color } : null,
        ]}>
          {item.label}
        </Text>
        {isSubmenu && (
          <Text style={styles.submenuArrow}>{"\u203a"}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

export function PopupMenu({ items, position, onClose, dropdownRef, triggerRef }: PopupMenuProps) {
  const localRef = useRef<View>(null);
  const ref = dropdownRef ?? localRef;
  const [submenu, setSubmenu] = useState<{ label: string; items: PopupMenuItem[] } | null>(null);


  useEffect(() => {
    if (!isWeb) return;
    const handler = (e: MouseEvent) => {
      const el = (ref.current as any);
      if (el && el.contains(e.target)) return;
      const trigger = (triggerRef?.current as any);
      if (trigger && trigger.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, ref, triggerRef]);

  const menuStyle = isWeb && position ? {
    position: "fixed" as any,
    top: position.top,
    left: position.left,
    transform: "translateX(-100%)" as any,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    minWidth: 160,
    zIndex: 9999,
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    paddingVertical: 4,
  } as any : styles.menu;

  const activeItems = submenu ? submenu.items : items;

  return (
    <PortalWeb>
      <View ref={ref} style={menuStyle}>
        {submenu && (
          <TouchableOpacity
            style={styles.backItem}
            onPress={() => setSubmenu(null)}
            activeOpacity={0.6}
          >
            <Text style={styles.backText}>{"\u2039"} {submenu.label}</Text>
          </TouchableOpacity>
        )}
        {activeItems.map((item, i) => {
          if (item.type === "separator") {
            return <View key={`sep-${i}`} style={styles.separator} />;
          }
          if (item.type === "submenu") {
            return (
              <HoverableItem
                key={`${item.label}-${i}`}
                item={item}

                onPress={() => setSubmenu({ label: item.label, items: item.items })}
              />
            );
          }
          return (
            <HoverableItem
              key={`${item.label}-${i}`}
              item={item}
              onPress={() => { onClose(); item.onPress(); }}
            />
          );
        })}
      </View>
    </PortalWeb>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    minWidth: 160,
    zIndex: 9999,
    paddingVertical: 4,
    ...(isWeb ? { boxShadow: "0 4px 12px rgba(0,0,0,0.3)" } : {}),
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  itemActive: {
    backgroundColor: `${colors.accent}18`,
  },
  itemHover: {
    backgroundColor: colors.surfaceHover,
  },
  itemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  itemText: {
    color: colors.text,
    fontSize: 13,
  },
  itemTextActive: {
    color: colors.accent,
    fontWeight: "600",
  },
  submenuArrow: {
    color: colors.textMuted,
    fontSize: 16,
    marginLeft: spacing.sm,
  },
  backItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 2,
  },
  backText: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
