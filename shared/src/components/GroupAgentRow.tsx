import { useCallback, useEffect, useRef, useState } from "react";
import { View, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { ProcessProvider } from "../types/process";
import { PopupMenu } from "./PopupMenu";

const COLLAPSED_HEIGHT = 32;
const LINE_HEIGHT = 17;
const MAX_ROWS = 20;
const VERTICAL_PADDING = 12;
const EXPANDED_MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS + VERTICAL_PADDING;

export function GroupAgentRow({
  onRunAgent,
  getAgentProviders,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider) => void | Promise<void>;
  getAgentProviders?: () => Promise<ProcessProvider[]>;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [availableProviders, setAvailableProviders] = useState<ProcessProvider[] | null>(null);
  const inputRef = useRef<TextInput>(null);
  const buttonRef = useRef<any>(null);
  const hadFocusRef = useRef(false);
  // Expand only once the user inserts a newline (Enter key).
  const expanded = prompt.includes("\n");

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

  const loadProviders = useCallback(async () => {
    if (!getAgentProviders) return [] as ProcessProvider[];
    const providers = await getAgentProviders();
    setAvailableProviders(providers);
    return providers;
  }, [getAgentProviders]);

  useEffect(() => {
    if (!getAgentProviders) return;
    void loadProviders();
  }, [getAgentProviders, loadProviders]);

  const runWithProvider = async (provider?: ProcessProvider) => {
    if (!prompt.trim() || sending) return;
    const nextPrompt = prompt.trim();
    setSending(true);
    try {
      await onRunAgent(nextPrompt, provider);
      setPrompt("");
      setProviderMenuOpen(false);
    } finally {
      setSending(false);
    }
  };

  const openProviderMenu = async (node?: any) => {
    const providers = availableProviders ?? await loadProviders();
    if (providers.length <= 1) {
      await runWithProvider(providers[0]);
      return;
    }
    if (isWeb) {
      const target = node ?? buttonRef.current;
      const rect = target?.getBoundingClientRect?.();
      if (rect) {
        setProviderMenuPos({ top: rect.bottom + 4, left: rect.right });
      }
    }
    setProviderMenuOpen(true);
  };

  const isWeb = Platform.OS === "web";

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
    onKeyPress: (e: any) => {
      const ne = e.nativeEvent ?? e;
      if (ne.key !== "Enter") return;
      if (ne.metaKey || ne.ctrlKey) {
        e.preventDefault?.();
        void openProviderMenu((e as any)?.currentTarget ?? (e as any)?.target);
        return;
      }
      // Plain Enter in the collapsed (single-line) input would submit the form
      // by default. Intercept it and insert a newline so the input expands.
      if (!expanded) {
        e.preventDefault?.();
        setPrompt((p) => p + "\n");
      }
    },
    editable: !sending,
  };

  return (
    <View style={[styles.row, expanded ? styles.rowExpanded : styles.rowCollapsed]}>
      {expanded ? (
        <TextInput
          {...commonProps}
          ref={inputRef}
          multiline
          style={[
            styles.input,
            {
              height: expandedHeight,
              maxHeight: EXPANDED_MAX_HEIGHT,
              textAlignVertical: "top",
              paddingVertical: 6,
              lineHeight: LINE_HEIGHT,
            },
          ]}
        />
      ) : (
        <TextInput
          {...commonProps}
          ref={inputRef}
          style={[styles.input, styles.inputCollapsed]}
        />
      )}
      <TouchableOpacity
        ref={buttonRef}
        style={[styles.btn, (!prompt.trim() || sending) && styles.btnDisabled]}
        onPress={(e: any) => { void openProviderMenu(e?.currentTarget ?? e?.target); }}
        disabled={!prompt.trim() || sending}
        activeOpacity={0.7}
      >
        <View style={styles.btnIcon}>
          <View style={styles.triangle} />
        </View>
      </TouchableOpacity>
      {providerMenuOpen && (
        <PopupMenu
          position={providerMenuPos}
          triggerRef={buttonRef}
          autoFocus
          onClose={() => setProviderMenuOpen(false)}
          items={(availableProviders ?? []).map((provider) => ({
            type: "item" as const,
            label: provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "OpenCode",
            onPress: () => { void runWithProvider(provider); },
          }))}
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
  input: {
    flex: 1,
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
