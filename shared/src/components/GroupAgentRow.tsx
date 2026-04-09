import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { ProcessProvider } from "../types/process";
import { JobKindIcon } from "./JobKindIcon";
import { PopupMenu } from "./PopupMenu";

const COLLAPSED_HEIGHT = 32;
const LINE_HEIGHT = 17;
const MAX_ROWS = 20;
const VERTICAL_PADDING = 12;
const EXPANDED_MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS + VERTICAL_PADDING;

export function GroupAgentRow({
  onRunAgent,
  provider,
  providers = [provider],
  onProviderChange,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider) => void | Promise<void>;
  provider: ProcessProvider;
  providers?: ProcessProvider[];
  onProviderChange?: (provider: ProcessProvider) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [manualExpandedHeight, setManualExpandedHeight] = useState<number | null>(null);
  const inputRef = useRef<TextInput>(null);
  const hadFocusRef = useRef(false);
  const providerButtonRef = useRef<any>(null);
  // Expand only once the user inserts a newline (Enter key).
  const expanded = prompt.includes("\n");
  const providerOptions = useMemo(() => {
    const seen = new Set<ProcessProvider>();
    return providers.filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  }, [providers]);

  // When the input mode swaps (single-line <-> multiline), focus is lost on web
  // because the underlying DOM element changes. Refocus if this editor was active.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!hadFocusRef.current) return;
    const node = inputRef.current as unknown as HTMLInputElement | HTMLTextAreaElement | null;
    if (!node) return;
    if (document.activeElement === node) return;
    node.focus();
    const len = prompt.length;
    try { node.setSelectionRange(len, len); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  // Grow purely from the line count so there is no remeasure race.
  const lineCount = prompt.split("\n").length;
  const expandedHeight = Math.min(
    Math.max(lineCount, 2) * LINE_HEIGHT + VERTICAL_PADDING,
    EXPANDED_MAX_HEIGHT,
  );
  const effectiveExpandedHeight = Math.max(expandedHeight, manualExpandedHeight ?? 0);

  useEffect(() => {
    if (expanded) return;
    setManualExpandedHeight(null);
  }, [expanded]);

  const runWithProvider = async (overrideProvider?: ProcessProvider) => {
    if (!prompt.trim() || sending) return;
    const nextPrompt = prompt.trim();
    setSending(true);
    try {
      await onRunAgent(nextPrompt, overrideProvider ?? provider);
      setPrompt("");
    } finally {
      setSending(false);
    }
  };

  const cycleProvider = (direction: 1 | -1) => {
    if (providerOptions.length <= 1) return;
    const currentIndex = Math.max(providerOptions.indexOf(provider), 0);
    const nextIndex = (currentIndex + direction + providerOptions.length) % providerOptions.length;
    onProviderChange?.(providerOptions[nextIndex]);
    setProviderMenuOpen(false);
  };

  const setInputRef = (node: TextInput | null) => {
    inputRef.current = node;
    if (Platform.OS !== "web" || !node) return;
    const el = node as unknown as HTMLElement;
    if (el.tagName === "TEXTAREA") {
      (el as HTMLTextAreaElement).style.resize = "none";
      (el as HTMLTextAreaElement).style.overflow = "auto";
    }
  };

  const handleResizeGripMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node) return;
    const startY = e.clientY;
    const startHeight = node.offsetHeight;
    const onMove = (ev: MouseEvent) => {
      setManualExpandedHeight(Math.max(expandedHeight, startHeight + (ev.clientY - startY)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [expandedHeight]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = inputRef.current as unknown as HTMLElement | null;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void runWithProvider();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setPrompt((p) => p + "\n");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        cycleProvider(e.shiftKey ? -1 : 1);
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  });

  const commonProps = {
    value: prompt,
    onChangeText: setPrompt,
    placeholder: "Run agent in this folder...",
    placeholderTextColor: colors.textMuted,
    inputAccessoryViewID: Platform.OS === "ios" ? "keyboard-dismiss" : undefined,
    onFocus: () => {
      hadFocusRef.current = true;
    },
    onBlur: () => {
      hadFocusRef.current = false;
    },
    editable: !sending,
    ...(Platform.OS !== "web"
      ? {
          onKeyPress: (e: any) => {
            const ne = e.nativeEvent ?? e;
            if (ne.key !== "Enter") return;
            if (!expanded) {
              e.preventDefault?.();
              setPrompt((p) => p + "\n");
            }
          },
        }
      : {}),
  };

  return (
    <View style={[styles.row, expanded ? styles.rowExpanded : styles.rowCollapsed]}>
      <View style={styles.inputWrap}>
        {expanded ? (
          <TextInput
            {...commonProps}
            ref={setInputRef}
            multiline
            style={[
              styles.input,
              {
                height: effectiveExpandedHeight,
                maxHeight: EXPANDED_MAX_HEIGHT,
                textAlignVertical: "top",
                paddingVertical: 6,
                paddingBottom: Platform.OS === "web" ? 18 : 6,
                lineHeight: LINE_HEIGHT,
                ...(Platform.OS === "web"
                  ? ({ outlineStyle: "none" } as any)
                  : {}),
              },
            ]}
          />
        ) : (
          <TextInput
            {...commonProps}
            ref={setInputRef}
            style={[styles.input, styles.inputCollapsed]}
          />
        )}
        {expanded && Platform.OS === "web" && (
          <>
            <View
              onMouseDown={handleResizeGripMouseDown as any}
              style={styles.resizeHint}
            >
              <Text style={styles.resizeHintText}>resize</Text>
            </View>
            <View
              onMouseDown={handleResizeGripMouseDown as any}
              style={styles.resizeKnob}
            >
              <Text style={styles.resizeKnobText}>◢</Text>
            </View>
          </>
        )}
        <View style={styles.providerOverlay}>
          <TouchableOpacity
            ref={providerButtonRef}
            style={styles.providerButton}
            onPress={(e: any) => {
              if (Platform.OS === "web") {
                const node = e?.currentTarget ?? e?.target;
                if (node?.getBoundingClientRect) {
                  const rect = node.getBoundingClientRect();
                  setProviderMenuPos({ top: rect.bottom + 6, left: rect.right });
                }
              }
              setProviderMenuOpen((open) => !open);
            }}
            activeOpacity={0.7}
            disabled={providerOptions.length <= 1}
          >
            <JobKindIcon kind={provider} size={16} compact bare />
            {providerOptions.length > 1 && (
              <Text style={styles.providerButtonCaret}>{"\u25BE"}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity
        style={[styles.btn, (!prompt.trim() || sending) && styles.btnDisabled]}
        onPress={() => { void runWithProvider(); }}
        disabled={!prompt.trim() || sending}
        activeOpacity={0.7}
      >
        <View style={styles.btnIcon}>
          <View style={styles.triangle} />
        </View>
      </TouchableOpacity>
      {providerMenuOpen && providerOptions.length > 1 && (
        <PopupMenu
          items={providerOptions.map((option) => ({
            type: "item" as const,
            label: option === "claude" ? "Claude" : option === "codex" ? "Codex" : "OpenCode",
            active: option === provider,
            icon: <JobKindIcon kind={option} size={16} compact bare />,
            onPress: () => {
              onProviderChange?.(option);
              setProviderMenuOpen(false);
            },
          }))}
          position={providerMenuPos}
          onClose={() => setProviderMenuOpen(false)}
          triggerRef={providerButtonRef}
          autoFocus
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  rowCollapsed: { alignItems: "center" },
  rowExpanded: { alignItems: "flex-end" },
  inputWrap: {
    flex: 1,
    position: "relative",
  },
  input: {
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 12,
  },
  inputCollapsed: {
    height: COLLAPSED_HEIGHT,
    paddingVertical: 0,
  },
  providerOverlay: {
    position: "absolute",
    top: 5,
    right: 6,
    zIndex: 5,
    alignItems: "flex-end",
  },
  providerButton: {
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 5,
    paddingRight: 4,
    borderRadius: 999,
    backgroundColor: "rgba(10, 10, 10, 0.55)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  providerButtonCaret: {
    color: colors.textMuted,
    fontSize: 9,
    marginTop: -1,
  },
  resizeHint: {
    position: "absolute",
    right: 30,
    bottom: 6,
    height: 16,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.10)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 4,
    cursor: "ns-resize" as any,
  },
  resizeHintText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    userSelect: "none" as any,
  },
  resizeKnob: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.14)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
    cursor: "ns-resize" as any,
  },
  resizeKnobText: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 12,
    userSelect: "none" as any,
    transform: [{ translateY: 1 }],
  },
  btn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  btnIcon: {
    width: 12,
    height: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  triangle: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftColor: "#fff",
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    marginLeft: 2,
  },
  btnDisabled: { opacity: 0.5 },
});
