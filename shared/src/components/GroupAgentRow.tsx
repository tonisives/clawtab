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
const MIN_ROWS = 2;
const EXPANDED_MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS + VERTICAL_PADDING;

export function GroupAgentRow({
  onRunAgent,
  provider,
  providers = [provider],
  onProviderChange,
  focusSignal,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider) => void | Promise<void>;
  provider: ProcessProvider;
  providers?: ProcessProvider[];
  onProviderChange?: (provider: ProcessProvider) => void;
  focusSignal?: number;
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
  const useWebTextarea = Platform.OS === "web";
  const useMultilineInput = useWebTextarea || expanded;
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
    Math.max(lineCount, MIN_ROWS) * LINE_HEIGHT + VERTICAL_PADDING,
    EXPANDED_MAX_HEIGHT,
  );
  const effectiveExpandedHeight = Math.max(expandedHeight, manualExpandedHeight ?? 0);

  useEffect(() => {
    if (expanded || useWebTextarea) return;
    setManualExpandedHeight(null);
  }, [expanded, useWebTextarea]);

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

  const lastFocusSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusSignal === lastFocusSignalRef.current) return;
    lastFocusSignalRef.current = focusSignal;
    if (typeof focusSignal === "number" && focusSignal > 0) {
      inputRef.current?.focus();
    }
  }, [focusSignal]);

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

  const inputHeight = useWebTextarea
    ? Math.max(MIN_ROWS * LINE_HEIGHT + VERTICAL_PADDING, effectiveExpandedHeight)
    : effectiveExpandedHeight;

  return (
    <View style={[styles.row, useMultilineInput ? styles.rowExpanded : styles.rowCollapsed]}>
      <View style={styles.inputWrap}>
        {useMultilineInput ? (
          <TextInput
            {...commonProps}
            ref={setInputRef}
            multiline
            style={[
              styles.input,
              {
                height: inputHeight,
                maxHeight: EXPANDED_MAX_HEIGHT,
                textAlignVertical: "top",
                paddingVertical: 6,
                paddingBottom: useWebTextarea ? 18 : 6,
                lineHeight: LINE_HEIGHT,
                ...(useWebTextarea
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
        {useWebTextarea && (
          <div onMouseDown={handleResizeGripMouseDown} style={styles.resizeKnob as any}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={styles.resizeKnobIcon as any}>
              <path
                d="M3 11L11 3M6.5 11L11 6.5M9.5 11L11 9.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        )}
        <Text style={styles.shortcutHint}>Cmd+N</Text>
      </View>
      <View style={styles.actionsCol}>
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
      </View>
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
  shortcutHint: {
    position: "absolute",
    right: 8,
    top: 10,
    color: colors.textMuted,
    fontSize: 10,
    pointerEvents: "none" as any,
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
  actionsCol: {
    gap: spacing.xs,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  providerButton: {
    height: 20,
    minWidth: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
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
  resizeKnob: {
    position: "absolute",
    right: 6,
    bottom: 5,
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
    cursor: "ns-resize" as any,
    userSelect: "none" as any,
  },
  resizeKnobIcon: {
    color: colors.textMuted,
    opacity: 0.95,
    pointerEvents: "none" as any,
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
