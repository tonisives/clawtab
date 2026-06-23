import { useCallback, useEffect, useRef } from "react";
import type * as React from "react";
import { Platform, type ScrollView, type TextInput, type View } from "react-native";

interface UseJobListRefsParams {
  dragActive?: boolean;
  sidebarFocusRef?: React.MutableRefObject<{ focus: () => void } | null>;
}

export function useJobListRefs({ dragActive, sidebarFocusRef }: UseJobListRefsParams) {
  const scrollRef = useRef<ScrollView>(null);
  const searchRef = useRef<TextInput>(null);
  const containerRef = useRef<View>(null);
  const hoverSwitchTimerRef = useRef<number | null>(null);
  const groupMenuDropdownRef = useRef<View>(null);
  const groupMenuTriggerRef = useRef<any>(null);
  const groupMenuTriggerRefs = useRef<Record<string, any>>({});
  const sortTriggerRef = useRef<any>(null);

  useEffect(() => {
    if (!dragActive && hoverSwitchTimerRef.current) {
      clearTimeout(hoverSwitchTimerRef.current);
      hoverSwitchTimerRef.current = null;
    }
  }, [dragActive]);

  useEffect(() => {
    if (sidebarFocusRef) {
      sidebarFocusRef.current = {
        focus: () => {
          const element = (containerRef.current as any) as HTMLElement | undefined;
          element?.focus?.();
        },
      };
    }
    return () => { if (sidebarFocusRef) sidebarFocusRef.current = null; };
  }, [sidebarFocusRef]);

  const handleContainerMouseDown = useCallback(() => {
    if (Platform.OS !== "web") return;
    const container = (containerRef.current as any) as HTMLElement | undefined;
    if (!container) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && !container.contains(active)) {
      (document.activeElement as HTMLElement)?.blur?.();
    }
  }, []);

  const containerWebProps = Platform.OS === "web"
    ? { tabIndex: -1 as const, onMouseDown: handleContainerMouseDown, style: { flex: 1, outline: "none" } as const }
    : {};
  const containerStyle = Platform.OS !== "web" ? { flex: 1 } : undefined;

  return {
    containerRef,
    containerStyle,
    containerWebProps,
    groupMenuDropdownRef,
    groupMenuTriggerRef,
    groupMenuTriggerRefs,
    hoverSwitchTimerRef,
    scrollRef,
    searchRef,
    sortTriggerRef,
  };
}
