import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { AgentModelOption, ProcessProvider } from "../types/process";
import { JobKindIcon } from "./JobKindIcon";
import { PopupMenu } from "./PopupMenu";

let createPortalFn: ((children: ReactNode, container: Element) => ReactNode) | null = null;
if (Platform.OS === "web") {
  import("react-dom").then((mod) => { createPortalFn = mod.createPortal; });
}

function PortalWeb({ children }: { children: ReactNode }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (Platform.OS === "web" && !createPortalFn) {
      import("react-dom").then((mod) => {
        createPortalFn = mod.createPortal;
        forceUpdate((n) => n + 1);
      });
    }
  }, []);
  if (Platform.OS !== "web" || !createPortalFn) return <>{children}</>;
  return createPortalFn(children, document.body);
}

function ModelToast({ label, anchorRect }: { label: string; anchorRect: DOMRect }) {
  return (
    <div
      style={{
        position: "fixed",
        top: anchorRect.bottom + 6,
        left: anchorRect.left + anchorRect.width / 2,
        transform: "translateX(-50%)",
        background: "rgba(30, 30, 35, 0.96)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        padding: "5px 12px",
        color: "var(--text, #e8e8e8)",
        fontSize: 12,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: 40000,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        animation: "clawtab-toast-fade 1.4s ease forwards",
      } as any}
    >
      {label}
    </div>
  );
}

const ACTIONS_COL_HEIGHT = 20 + spacing.xs + 32;
const LINE_HEIGHT = 17;
const MAX_ROWS = 20;
const VERTICAL_PADDING = 12;
const EXPANDED_MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS + VERTICAL_PADDING;

const AGENT_QUERY_STORAGE_PREFIX = "clawtab_group_agent_query_";

function loadStoredQuery(workDir?: string): string {
  if (!workDir || Platform.OS !== "web" || typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(AGENT_QUERY_STORAGE_PREFIX + workDir) ?? "";
  } catch {
    return "";
  }
}

function saveStoredQuery(workDir: string | undefined, value: string) {
  if (!workDir || Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    if (value) {
      localStorage.setItem(AGENT_QUERY_STORAGE_PREFIX + workDir, value);
    } else {
      localStorage.removeItem(AGENT_QUERY_STORAGE_PREFIX + workDir);
    }
  } catch {}
}

export function GroupAgentRow({
  onRunAgent,
  provider,
  providers = [provider],
  onProviderChange,
  model,
  modelOptions = [],
  onModelChange,
  focusSignal,
  workDir,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null) => void | Promise<void>;
  provider: ProcessProvider;
  providers?: ProcessProvider[];
  onProviderChange?: (provider: ProcessProvider) => void;
  model?: string | null;
  modelOptions?: AgentModelOption[];
  onModelChange?: (provider: ProcessProvider, model: string | null) => void;
  focusSignal?: number;
  workDir?: string;
}) {
  const [prompt, setPromptState] = useState(() => loadStoredQuery(workDir));
  const setPrompt = useCallback((value: string | ((prev: string) => string)) => {
    setPromptState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      saveStoredQuery(workDir, next);
      return next;
    });
  }, [workDir]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [manualExpandedHeight, setManualExpandedHeight] = useState<number | null>(null);
  const [toast, setToast] = useState<{ label: string; anchorRect: DOMRect; key: number } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastKeyRef = useRef(0);
  const inputRef = useRef<TextInput>(null);
  const providerButtonRef = useRef<any>(null);
  const providerOptions = useMemo(() => {
    const seen = new Set<ProcessProvider>();
    return providers.filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  }, [providers]);

  const useWebTextarea = Platform.OS === "web";
  const lineCount = prompt.split("\n").length;
  const fallbackHeight = Math.min(
    Math.max(lineCount, 1) * LINE_HEIGHT + VERTICAL_PADDING,
    EXPANDED_MAX_HEIGHT,
  );
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const expandedHeight = measuredHeight ?? fallbackHeight;

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node || node.tagName !== "TEXTAREA") return;
    const prev = node.style.height;
    node.style.height = "0px";
    const needed = node.scrollHeight;
    node.style.height = prev;
    const minH = LINE_HEIGHT + VERTICAL_PADDING;
    const clamped = Math.min(EXPANDED_MAX_HEIGHT, Math.max(minH, needed));
    setMeasuredHeight(clamped);
  }, [prompt]);

  const runWithProvider = async (overrideProvider?: ProcessProvider, overrideModel?: string | null) => {
    const resolvedProvider = overrideProvider ?? provider;
    if (resolvedProvider !== "shell" && !prompt.trim()) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    const nextPrompt = prompt.trim();
    setSending(true);
    try {
      await onRunAgent(nextPrompt, overrideProvider ?? provider, overrideModel !== undefined ? overrideModel : (model ?? null));
      setPrompt("");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const setInputRef = useCallback((node: TextInput | null) => {
    inputRef.current = node;
    if (Platform.OS !== "web" || !node) return;
    const el = node as unknown as HTMLElement;
    if (el.tagName === "TEXTAREA") {
      (el as HTMLTextAreaElement).style.resize = "none";
      (el as HTMLTextAreaElement).style.overflow = "auto";
    }
  }, []);

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

  const runWithProviderRef = useRef(runWithProvider);
  const providerRef = useRef(provider);
  const providerOptionsRef = useRef(providerOptions);
  const onProviderChangeRef = useRef(onProviderChange);
  const modelRef = useRef(model);
  const modelOptionsRef = useRef(modelOptions);
  const onModelChangeRef = useRef(onModelChange);
  useEffect(() => { runWithProviderRef.current = runWithProvider; });
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { providerOptionsRef.current = providerOptions; }, [providerOptions]);
  useEffect(() => { onProviderChangeRef.current = onProviderChange; }, [onProviderChange]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { modelOptionsRef.current = modelOptions; }, [modelOptions]);
  useEffect(() => { onModelChangeRef.current = onModelChange; }, [onModelChange]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = inputRef.current as unknown as HTMLElement | null;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void runWithProviderRef.current();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setPrompt((p) => p + "\n");
        return;
      }
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const opts = modelOptionsRef.current;
        if (opts.length <= 1) return;
        const foundIndex = opts.findIndex((o) => o.provider === providerRef.current && o.modelId === modelRef.current);
        const step = e.shiftKey ? -1 : 1;
        const currentIndex = foundIndex !== -1 ? foundIndex : (step === 1 ? -1 : opts.length);
        const nextIndex = (currentIndex + step + opts.length) % opts.length;
        const next = opts[nextIndex];
        onModelChangeRef.current?.(next.provider, next.modelId);
        onProviderChangeRef.current?.(next.provider);
        setProviderMenuOpen(false);
        if (Platform.OS === "web") {
          const btn = providerButtonRef.current as HTMLElement | null;
          const anchorRect = btn?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastKeyRef.current += 1;
          const key = toastKeyRef.current;
          setToast({ label: next.label, anchorRect, key });
          toastTimerRef.current = setTimeout(() => setToast((t) => t?.key === key ? null : t), 1400);
        }
      }
    };
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
    // Refs carry live values; listener must attach exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    editable: !sending,
  };

  return (
    <View
      style={[styles.row, styles.rowExpanded]}
      {...(Platform.OS === "web" && workDir ? { dataSet: { agentWorkdir: workDir } } : {})}
    >
      <View style={styles.inputWrap}>
        <TextInput
          {...commonProps}
          ref={setInputRef}
          multiline
          {...(Platform.OS === "web" && workDir ? { dataSet: { agentInput: workDir } } : {})}
          style={[
            styles.input,
            {
              minHeight: ACTIONS_COL_HEIGHT,
              maxHeight: EXPANDED_MAX_HEIGHT,
              textAlignVertical: "top",
              paddingVertical: 6,
              paddingBottom: useWebTextarea ? 18 : 6,
              lineHeight: LINE_HEIGHT,
              ...(manualExpandedHeight
                ? { height: Math.max(manualExpandedHeight, ACTIONS_COL_HEIGHT) }
                : useWebTextarea
                  ? { height: expandedHeight }
                  : {}),
              ...(useWebTextarea
                ? ({ outlineStyle: "none" } as any)
                : {}),
            },
          ]}
        />
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
          disabled={modelOptions.length <= 1}
        >
          <JobKindIcon kind={provider} size={16} compact bare />
          {modelOptions.length > 1 && (
            <Text style={styles.providerButtonCaret}>{"\u25BE"}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, ((provider !== "shell" && !prompt.trim()) || sending) && styles.btnDisabled]}
          onPress={() => { void runWithProvider(); }}
          disabled={(provider !== "shell" && !prompt.trim()) || sending}
          activeOpacity={0.7}
        >
          <View style={styles.btnIcon}>
            <View style={styles.triangle} />
          </View>
        </TouchableOpacity>
      </View>
      {providerMenuOpen && modelOptions.length > 1 && (
        <PopupMenu
          items={modelOptions.map((opt) => ({
            type: "item" as const,
            label: opt.label,
            active: opt.provider === provider && opt.modelId === model,
            icon: <JobKindIcon kind={opt.provider} size={16} compact bare />,
            onPress: () => {
              onModelChange?.(opt.provider, opt.modelId);
              onProviderChange?.(opt.provider);
              setProviderMenuOpen(false);
            },
          }))}
          position={providerMenuPos}
          onClose={() => setProviderMenuOpen(false)}
          triggerRef={providerButtonRef}
          autoFocus
        />
      )}
      {Platform.OS === "web" && toast && (
        <PortalWeb>
          <ModelToast key={toast.key} label={toast.label} anchorRect={toast.anchorRect} />
        </PortalWeb>
      )}
    </View>
  );
}

if (Platform.OS === "web" && typeof document !== "undefined") {
  const STYLE_ID = "clawtab-toast-style";
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `@keyframes clawtab-toast-fade { 0% { opacity: 0; transform: translateX(-50%) translateY(4px); } 12% { opacity: 1; transform: translateX(-50%) translateY(0); } 70% { opacity: 1; } 100% { opacity: 0; } }`;
    document.head.appendChild(s);
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
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
