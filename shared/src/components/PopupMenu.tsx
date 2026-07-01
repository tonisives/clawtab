import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet, Platform, useWindowDimensions } from "react-native";
import { colors } from "../theme/colors";
import { spacing, radius } from "../theme/spacing";

const isWeb = Platform.OS === "web";

// Load react-dom lazily on web only. On native this stays null and the menu
// renders inline. We use an async import to keep react-dom out of the static
// dependency graph for native bundlers, but resolve it at module load so the
// portal is ready before any menu opens.
let createPortalFn: ((children: ReactNode, container: Element) => ReactNode) | null = null;
let portalReady = false;
const portalListeners = new Set<() => void>();

if (isWeb) {
  import("react-dom").then((m) => {
    createPortalFn = m.createPortal as typeof createPortalFn;
    portalReady = true;
    portalListeners.forEach((fn) => fn());
    portalListeners.clear();
  }).catch(() => {
    portalReady = true;
  });
}

function usePortalReady(): boolean {
  const [ready, setReady] = useState(portalReady);
  useEffect(() => {
    if (portalReady) {
      if (!ready) setReady(true);
      return;
    }
    const listener = () => setReady(true);
    portalListeners.add(listener);
    return () => { portalListeners.delete(listener); };
  }, [ready]);
  return ready;
}

function PortalWeb({ children }: { children: ReactNode }) {
  const ready = usePortalReady();
  if (!isWeb) return <>{children}</>;
  if (!ready || !createPortalFn) return <>{children}</>;
  return createPortalFn(children, document.body);
}

export type PopupMenuItem =
  | { type: "item"; label: string; onPress: () => void; color?: string; active?: boolean; icon?: ReactNode; hint?: string }
  | { type: "separator" }
  | { type: "submenu"; label: string; items: PopupMenuItem[] };

interface PopupMenuProps {
  items: PopupMenuItem[];
  position?: { top: number; left: number } | null;
  onClose: () => void;
  dropdownRef?: React.RefObject<View | null>;
  /** Ref to the trigger button - clicks on it are ignored so the button's own toggle works */
  triggerRef?: React.RefObject<any>;
  autoFocus?: boolean;
  initialHighlight?: boolean;
  nativeBottomInset?: number;
  nativePlacement?: "auto" | "above" | "below";
}

function HoverableItem({ item, onPress, highlighted = false, onHover }: {
  item: Extract<PopupMenuItem, { type: "item" }> | Extract<PopupMenuItem, { type: "submenu" }>;
  onPress: () => void;
  highlighted?: boolean;
  onHover?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const webProps = isWeb ? {
    onMouseEnter: () => {
      setHovered(true);
      onHover?.();
    },
    onMouseLeave: () => setHovered(false),
  } : {};

  const isSubmenu = item.type === "submenu";
  const color = item.type === "item" ? item.color : undefined;
  const active = item.type === "item" ? item.active : false;
  const hint = item.type === "item" ? item.hint : undefined;

  return (
    <TouchableOpacity
      style={[
        styles.item,
        active && styles.itemActive,
        highlighted && styles.itemHover,
        hovered && styles.itemHover,
      ]}
      onPress={onPress}
      activeOpacity={0.6}
      {...webProps}
    >
      <View style={styles.itemRow}>
        <View style={styles.itemLabelWrap}>
          {item.type === "item" && item.icon ? (
            <View style={styles.itemIconWrap}>{item.icon}</View>
          ) : null}
          <Text style={[
            styles.itemText,
            active && styles.itemTextActive,
            color ? { color } : null,
          ]} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
        {hint ? <Text style={styles.itemHint}>{hint}</Text> : null}
        {isSubmenu && (
          <Text style={styles.submenuArrow}>{"\u203a"}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

export function PopupMenu({ items, position, onClose, dropdownRef, triggerRef, autoFocus = false, initialHighlight = true, nativeBottomInset = 8, nativePlacement = "auto" }: PopupMenuProps) {
  const localRef = useRef<View>(null);
  const ref = dropdownRef ?? localRef;
  const windowSize = useWindowDimensions();
  const [submenu, setSubmenu] = useState<{ label: string; items: PopupMenuItem[] } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [clampedPos, setClampedPos] = useState<{ top: number; left: number } | null>(null);
  const [nativeMenuHeight, setNativeMenuHeight] = useState(0);
  const [nativeTriggerRect, setNativeTriggerRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const prevPositionRef = useRef(position);

  const activeItems = submenu ? submenu.items : items;
  const actionableIndexes = activeItems
    .map((item, index) => (item.type === "separator" ? -1 : index))
    .filter((index) => index >= 0);

  useEffect(() => {
    setHighlightedIndex(initialHighlight ? actionableIndexes[0] ?? -1 : -1);
  }, [submenu, items.length, actionableIndexes.join(","), initialHighlight]);

  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    const timeout = window.setTimeout(() => {
      const node = ref.current as any;
      node?.focus?.();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [autoFocus, ref, submenu]);

  // Clamp position to stay within the viewport after the menu renders
  useEffect(() => {
    // When position reference changes, reset so we re-measure
    if (prevPositionRef.current !== position) {
      prevPositionRef.current = position;
      setClampedPos(null);
      return;
    }
    if (!isWeb || !position) { setClampedPos(null); return; }
    const el = ref.current as any as HTMLElement | null;
    if (!el) { setClampedPos((prev) => (prev?.top === position.top && prev?.left === position.left ? prev : position)); return; }
    const menuRect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const menuW = menuRect.width || 160;
    const menuH = menuRect.height || 0;

    // Callers pass left = rect.right (the trigger's right edge).
    // Mirror the old translateX(-100%): menu right-aligns to that point.
    let left = position.left - menuW;
    if (left < margin) left = margin;
    if (left + menuW > vw - margin) left = vw - menuW - margin;

    // Vertical: prefer below trigger, flip above if it would overflow
    let top = position.top;
    if (menuH > 0 && top + menuH > vh - margin) {
      const triggerEl = triggerRef?.current as HTMLElement | null;
      if (triggerEl) {
        const triggerRect = triggerEl.getBoundingClientRect();
        const flippedTop = triggerRect.top - menuH - 6;
        if (flippedTop >= margin) top = flippedTop;
        else top = Math.max(margin, vh - menuH - margin);
      } else {
        top = Math.max(margin, vh - menuH - margin);
      }
    }

    setClampedPos((prev) => (prev?.top === top && prev?.left === left ? prev : { top, left }));
  });

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

  useEffect(() => {
    if (isWeb || !triggerRef?.current?.measureInWindow) {
      setNativeTriggerRect(null);
      return;
    }
    triggerRef.current.measureInWindow((x: number, y: number, width: number, height: number) => {
      setNativeTriggerRect({ x, y, width, height });
    });
  }, [position, triggerRef]);

  const estimateNativeMenuHeight = () => {
    const contentHeight = activeItems.reduce((total, item) => total + (item.type === "separator" ? 11 : 48), 16);
    return contentHeight + (submenu ? 48 : 0);
  };

  const nativeResolvedPos = (() => {
    if (isWeb) return null;
    const margin = 8;
    const menuWidth = Math.min(520, Math.max(260, windowSize.width * 0.75));
    const menuHeight = nativeMenuHeight || estimateNativeMenuHeight();
    const bottomLimit = windowSize.height - nativeBottomInset - margin;
    const triggerTop = nativePlacement === "above" && position ? position.top : nativeTriggerRect?.y ?? (position?.top ?? 44);
    const triggerLeft = nativePlacement === "above" && position ? position.left : nativeTriggerRect?.x ?? (position?.left ?? 12);
    const triggerHeight = nativeTriggerRect?.height ?? 22;
    const belowTop = position?.top ?? (triggerTop + triggerHeight + 6);
    const aboveTop = triggerTop - menuHeight - 6;

    let top = belowTop;
    if (nativePlacement === "above") {
      top = aboveTop >= margin ? aboveTop : belowTop;
    } else if (nativePlacement === "below") {
      top = belowTop;
    } else if (top + menuHeight > bottomLimit) {
      top = aboveTop >= margin ? aboveTop : Math.max(margin, bottomLimit - menuHeight);
    }
    if (top + menuHeight > bottomLimit) top = Math.max(margin, bottomLimit - menuHeight);
    if (top < margin) top = margin;

    let left = position?.left ?? triggerLeft;
    if (left + menuWidth > windowSize.width - margin) left = windowSize.width - menuWidth - margin;
    if (left < margin) left = margin;

    return { top, left };
  })();

  const resolvedPos = clampedPos;
  const menuStyle = isWeb
    ? (position ? {
        position: "fixed" as any,
        top: resolvedPos?.top ?? position.top,
        left: resolvedPos?.left ?? (position.left - 160),
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radius.sm,
        minWidth: 160,
        zIndex: 2147483647,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        paddingVertical: 4,
      } as any : [styles.menu, styles.webInlineMenu])
    : [
        styles.menu,
        styles.nativeMenu,
        { top: nativeResolvedPos?.top ?? position?.top ?? 44, left: nativeResolvedPos?.left ?? position?.left ?? 12 },
      ];

  const stepHighlight = (direction: 1 | -1) => {
    if (actionableIndexes.length === 0) return;
    const currentPosition = actionableIndexes.indexOf(highlightedIndex);
    const nextPosition = currentPosition === -1
      ? (direction === 1 ? 0 : actionableIndexes.length - 1)
      : (currentPosition + direction + actionableIndexes.length) % actionableIndexes.length;
    setHighlightedIndex(actionableIndexes[nextPosition] ?? -1);
  };

  const activateIndex = (index: number) => {
    const item = activeItems[index];
    if (!item || item.type === "separator") return;
    if (item.type === "submenu") {
      setSubmenu({ label: item.label, items: item.items });
      return;
    }
    onClose();
    item.onPress();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isWeb) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (submenu) {
        setSubmenu(null);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      stepHighlight(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      stepHighlight(-1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setHighlightedIndex(actionableIndexes[0] ?? -1);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setHighlightedIndex(actionableIndexes[actionableIndexes.length - 1] ?? -1);
      return;
    }
    if (e.key === "ArrowLeft" && submenu) {
      e.preventDefault();
      setSubmenu(null);
      return;
    }
    if (e.key === "ArrowRight" && highlightedIndex >= 0) {
      const item = activeItems[highlightedIndex];
      if (item?.type === "submenu") {
        e.preventDefault();
        setSubmenu({ label: item.label, items: item.items });
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (highlightedIndex < 0) return;
      e.preventDefault();
      activateIndex(highlightedIndex);
    }
  };

  const menu = (
    <View
      ref={ref}
      style={menuStyle}
      onLayout={isWeb ? undefined : (event) => setNativeMenuHeight(event.nativeEvent.layout.height)}
      {...(isWeb ? {
        tabIndex: -1,
        onKeyDown: handleKeyDown,
      } : {})}
    >
      {submenu && (
        <TouchableOpacity
          style={styles.backItem}
          onPress={() => {
            setSubmenu(null);
            setHighlightedIndex(actionableIndexes[0] ?? -1);
          }}
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
              highlighted={i === highlightedIndex}
              onHover={() => setHighlightedIndex(i)}
              onPress={() => setSubmenu({ label: item.label, items: item.items })}
            />
          );
        }
        return (
          <HoverableItem
            key={`${item.label}-${i}`}
            item={item}
            highlighted={i === highlightedIndex}
            onHover={() => setHighlightedIndex(i)}
            onPress={() => { onClose(); item.onPress(); }}
          />
        );
      })}
    </View>
  );

  if (!isWeb) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.nativeBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          {menu}
        </View>
      </Modal>
    );
  }

  return (
    <PortalWeb>
      {menu}
    </PortalWeb>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: "absolute",
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
  nativeMenu: {
    width: "75%",
    minWidth: 260,
    maxWidth: 520,
    paddingVertical: 8,
    borderRadius: 16,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(28,28,30,0.94)",
    shadowColor: "#000000",
    shadowOpacity: 0.34,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 18 },
    elevation: 24,
    transform: [{ scale: 0.96 }],
  },
  webInlineMenu: {
    top: "100%",
    right: 0,
  },
  nativeBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
    ...(isWeb ? {} : {
      backgroundColor: "rgba(255,255,255,0.11)",
      marginVertical: 5,
    }),
  },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...(isWeb ? {} : {
      paddingHorizontal: spacing.lg,
      paddingVertical: 13,
      minHeight: 48,
      justifyContent: "center",
    }),
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
    gap: spacing.md,
  },
  itemLabelWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minWidth: 0,
    flex: 1,
    flexShrink: 1,
    paddingRight: spacing.sm,
  },
  itemIconWrap: {
    width: 16,
    height: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  itemText: {
    color: colors.text,
    fontSize: 13,
    flexShrink: 1,
    ...(isWeb ? {} : {
      fontSize: 17,
      fontWeight: "600",
    }),
  },
  itemHint: {
    color: colors.textMuted,
    fontSize: 11,
    flexShrink: 0,
  },
  itemTextActive: {
    color: colors.accent,
    fontWeight: "600",
  },
  submenuArrow: {
    color: colors.textMuted,
    fontSize: 16,
    marginLeft: spacing.sm,
    ...(isWeb ? {} : {
      fontSize: 22,
    }),
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
    ...(isWeb ? {} : {
      fontSize: 16,
      fontWeight: "600",
    }),
  },
});
