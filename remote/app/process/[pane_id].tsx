import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Platform, Keyboard, TextInput, Pressable } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useJobsStore } from "../../src/store/jobs";
import { useNotificationStore } from "../../src/store/notifications";
import { JobKindIcon, XtermLog, PopupMenu, compactPath, findYesOption, kindForProcess, colors, radius, spacing } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { useWsStore } from "../../src/store/ws";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { registerRequest } from "../../src/lib/useRequestMap";
import { usePty } from "../../src/hooks/usePty";
import { useDemoPty } from "../../src/hooks/useDemoPty";
import { HeaderBackButton, HeaderTitleWithIcon } from "../../src/components/HeaderButtons";
import { confirm } from "../../src/lib/platform";
import { DEMO_PROCESSES } from "../../src/demo/data";

const KEYBOARD_TOOLBAR_HEIGHT = 48;
const KEYBOARD_EXTRA_CLEARANCE = 10;
const TERMINAL_BG = "#1c1c1e";

function encodeTerminalInput(text: string): string {
  if (typeof btoa === "function") return btoa(text);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i) & 0xff;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) & 0xff : 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += i + 1 < text.length ? chars[(triplet >> 6) & 63] : "=";
    output += i + 2 < text.length ? chars[triplet & 63] : "=";
  }
  return output;
}

export default function ProcessDetailScreen() {
  const { pane_id: rawPaneId } = useLocalSearchParams<{ pane_id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router]);

  // Tmux pane_ids start with % (e.g. %714) which gets mangled by URL encoding.
  // We encode % as _pct_ in URLs and decode it back here.
  const pane_id = (rawPaneId ?? "").replace(/_pct_/g, "%");

  const storeProcess = useJobsStore((s) =>
    s.detectedProcesses.find((p) => p.pane_id === pane_id),
  );
  const demoProcess = DEMO_PROCESSES.find((p) => p.pane_id === pane_id);
  const process = storeProcess ?? demoProcess;

  // If this pane belongs to a tracked job (not in detectedProcesses), redirect
  // to the job detail page instead.
  const jobs = useJobsStore((s) => s.jobs);
  const statuses = useJobsStore((s) => s.statuses);
  const questions = useNotificationStore((s) => s.questions);
  useEffect(() => {
    if (process) return; // found as detected process, no redirect needed
    const paneQuestions = questions.filter((q) => q.pane_id === pane_id);
    for (const q of paneQuestions) {
      if (q.matched_job) {
        router.replace(`/job/${q.matched_job}`);
        return;
      }
      for (const job of jobs) {
        if (statuses[job.name]?.state !== "running") continue;
        const dir = job.work_dir || job.path;
        if (dir && (q.cwd === dir || q.cwd.startsWith(dir + "/"))) {
          router.replace(`/job/${job.name}`);
          return;
        }
      }
      if (q.matched_group) {
        for (const job of jobs) {
          if (statuses[job.name]?.state !== "running") continue;
          if (job.group === q.matched_group) {
            router.replace(`/job/${job.name}`);
            return;
          }
        }
      }
    }
  }, [process, pane_id, questions, jobs, statuses, router]);

  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const loaded = useJobsStore((s) => s.loaded);

  // Cold start from notification: waiting for relay data
  const waitingForData = !process && !questions.some((q) => q.pane_id === pane_id) && (!connected || !desktopOnline || !loaded);

  const lastProcessRef = useRef(process);
  if (process) lastProcessRef.current = process;
  const lastProcess = lastProcessRef.current;
  const [stopping, setStopping] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const contextMenuRef = useRef<View>(null);
  const contextDropdownRef = useRef<View>(null);
  const contextButtonRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [copyModeActive, setCopyModeActive] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Derive tmux info from process or question (for panes not in detectedProcesses)
  const paneQuestion = questions.find((q) => q.pane_id === pane_id);
  const tmuxSession = (process ?? lastProcess)?.tmux_session ?? paneQuestion?.tmux_session ?? "";

  const displayName = (process ?? lastProcess)
    ? (process ?? lastProcess)!.cwd.replace(/^\/Users\/[^/]+/, "~")
    : paneQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? pane_id;
  const headerTitle = (process ?? lastProcess)
    ? compactPath((process ?? lastProcess)!.cwd)
    : paneQuestion?.cwd
      ? compactPath(paneQuestion.cwd)
      : pane_id;

  const activeProcess = process ?? lastProcess;
  const headerKind = activeProcess ? kindForProcess(activeProcess) : "claude";

  // PTY streaming terminal
  const termRef = useRef<XtermLogHandle | null>(null);
  const keyboardDismissRef = useRef<TextInput | null>(null);
  const { sendInput: ptySendInput, sendResize, connecting: ptyConnecting } = usePty(pane_id, tmuxSession, termRef);
  useDemoPty(pane_id, !!demoProcess);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (event) => {
      const keyboardHeight = event.endCoordinates?.height ?? 0;
      setKeyboardVisible(true);
      setKeyboardHeight(keyboardHeight);
      termRef.current?.setVisualOffset(Math.max(0, keyboardHeight + KEYBOARD_TOOLBAR_HEIGHT + KEYBOARD_EXTRA_CLEARANCE));
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
      termRef.current?.setVisualOffset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const options = paneQuestion?.options ?? [];

  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);
  const autoYesActive = autoYesPaneIds.has(pane_id);

  const handleToggleAutoYes = useCallback(() => {
    if (autoYesPaneIds.has(pane_id)) {
      disableAutoYes(pane_id);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.delete(pane_id);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      return;
    }
    const title = displayName;
    confirm("Enable auto-yes?", `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`, () => {
      enableAutoYes(pane_id);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.add(pane_id);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      if (paneQuestion) {
        const yesOpt = findYesOption(paneQuestion);
        if (yesOpt) {
          const s = getWsSend();
          if (s) {
            s({ type: "send_detected_process_input", id: nextId(), pane_id, text: yesOpt });
          }
          setTimeout(() => answerQuestion(paneQuestion.question_id), 1500);
        }
      }
    });
  }, [pane_id, autoYesPaneIds, enableAutoYes, disableAutoYes, displayName, paneQuestion, answerQuestion]);

  const handleSend = useCallback(
    (text: string) => {
      const send = getWsSend();
      if (!send || !text.trim()) return;

      send({
        type: "send_detected_process_input",
        id: nextId(),
        pane_id,
        text: text.trim(),
      });
      // Dismiss notification card if we just answered a question
      if (paneQuestion) {
        answerQuestion(paneQuestion.question_id);
      }
    },
    [pane_id, paneQuestion, answerQuestion],
  );

  const sendTmuxPaneKey = useCallback(
    (key: string) => {
      const send = getWsSend();
      if (!send) return;
      send({ type: "tmux_pane_key", pane_id, key });
    },
    [pane_id],
  );

  const scrollTerminal = useCallback(
    (direction: "up" | "down") => {
      setCopyModeActive(true);
      sendTmuxPaneKey(direction === "up" ? "copy-halfpage-up" : "copy-halfpage-down");
    },
    [sendTmuxPaneKey],
  );

  const exitCopyMode = useCallback(() => {
    setCopyModeActive(false);
    sendTmuxPaneKey("copy-cancel");
  }, [sendTmuxPaneKey]);

  const sendTerminalText = useCallback(
    (text: string) => {
      ptySendInput(encodeTerminalInput(text));
    },
    [ptySendInput],
  );

  const dismissTerminalKeyboard = useCallback(() => {
    termRef.current?.blur();
    keyboardDismissRef.current?.focus();
    setTimeout(() => {
      keyboardDismissRef.current?.blur();
      Keyboard.dismiss();
    }, 30);
  }, []);

  const doStop = async () => {
    const send = getWsSend();
    if (!send || stopping) return;
    setStopping(true);
    const id = nextId();
    send({ type: "stop_detected_process", id, pane_id });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    const ack = await Promise.race([
      registerRequest<{ success?: boolean; error?: string }>(id),
      timeout.then(() => null),
    ]);
    if (ack?.success !== false) {
      useJobsStore.getState().removeDetectedProcess(pane_id);
      if (router.canGoBack()) router.back();
      else router.replace("/(tabs)");
    }
    setStopping(false);
  };

  const handleStop = () => {
    confirm("Stop process", `Kill the Claude process in ${displayName}?`, doStop);
  };

  const [starting, setStarting] = useState(false);
  const handleStart = async () => {
    const send = getWsSend();
    if (!send || starting) return;
    setStarting(true);
    const workDir = (process ?? lastProcess)?.cwd;
    const id = nextId();
    send({ type: "run_agent", id, prompt: "", work_dir: workDir });
    setTimeout(() => setStarting(false), 3000);
  };

  const isAlive = !!process || !!paneQuestion;
  const closeContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);
  const openContextMenu = useCallback(
    (e?: any) => {
      if (Platform.OS !== "web") {
        setShowContextMenu((v) => !v);
        return;
      }

      const node = contextButtonRef.current?.getBoundingClientRect
        ? contextButtonRef.current
        : (e?.currentTarget ?? e?.target);
      if (node?.getBoundingClientRect) {
        const rect = node.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.right });
      }
      setShowContextMenu((v) => !v);
    },
    [],
  );

  if (waitingForData) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: pane_id }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>
            {!connected ? "Connecting..." : "Loading..."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerLeft: () => <HeaderBackButton onPress={handleBack} />,
          headerTitle: () => (
            <HeaderTitleWithIcon
              title={headerTitle}
              icon={<JobKindIcon kind={headerKind} size={26} bare />}
              onPress={showContextMenu ? closeContextMenu : undefined}
            />
          ),
          headerRight: () => (
            <View ref={contextMenuRef} style={styles.headerRightSlot}>
              <TouchableOpacity
                ref={contextButtonRef}
                style={styles.contextBtn}
                onPress={openContextMenu}
                activeOpacity={0.6}
                hitSlop={8}
              >
                <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
              </TouchableOpacity>
              {Platform.OS === "web" && showContextMenu && (
                <PopupMenu
                  dropdownRef={contextDropdownRef}
                  triggerRef={contextButtonRef}
                  position={menuPos}
                  onClose={() => setShowContextMenu(false)}
                  items={isAlive ? [
                    { type: "item", label: stopping ? "Stopping..." : "Stop", onPress: handleStop, color: colors.danger },
                  ] : [
                    { type: "item", label: starting ? "Starting..." : "Start", onPress: handleStart, color: colors.accent },
                  ]}
                />
              )}
            </View>
          ),
        }}
      />
      {Platform.OS !== "web" && showContextMenu ? (
        <Pressable
          style={styles.mobileContextBackdrop}
          onPress={closeContextMenu}
        />
      ) : null}
      {Platform.OS !== "web" && showContextMenu ? (
        <View style={styles.mobileContextMenu}>
          {isAlive ? (
            <TouchableOpacity
              style={styles.mobileContextItem}
              onPress={() => {
                setShowContextMenu(false);
                handleStop();
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.mobileContextText, { color: colors.danger }]}>
                {stopping ? "Stopping..." : "Stop"}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.mobileContextItem}
              onPress={() => {
                setShowContextMenu(false);
                handleStart();
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.mobileContextText, { color: colors.accent }]}>
                {starting ? "Starting..." : "Start"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}

      {activeProcess?.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Query</Text>
          <Text style={styles.queryText} numberOfLines={1}>
            {activeProcess.first_query}
          </Text>
        </View>
      )}
      {activeProcess?.last_query && activeProcess.last_query !== activeProcess.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Latest</Text>
          <Text style={[styles.queryText, { color: colors.textSecondary }]} numberOfLines={1}>
            {activeProcess.last_query}
          </Text>
        </View>
      )}

      <View style={[styles.terminalContainer, { paddingBottom: Math.max(12, insets.bottom + 8) }]}>
        <XtermLog
          ref={termRef}
          onData={ptySendInput}
          onResize={sendResize}
          interactive
        />
        <TerminalScrollButtons
          onScrollUp={() => scrollTerminal("up")}
          onScrollDown={() => scrollTerminal("down")}
          onExitCopyMode={exitCopyMode}
          copyModeActive={copyModeActive}
        />
        {ptyConnecting ? (
          <View style={styles.ptyConnectingOverlay} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.ptyConnectingText}>Connecting to agent...</Text>
          </View>
        ) : null}
      </View>
      {keyboardVisible ? (
        <TerminalKeyboardToolbar
          bottom={keyboardHeight}
          onDismiss={dismissTerminalKeyboard}
          onEscape={() => sendTerminalText("\x1b")}
          onArrowUp={() => sendTerminalText("\x1b[A")}
          onArrowDown={() => sendTerminalText("\x1b[B")}
          onArrowLeft={() => sendTerminalText("\x1b[D")}
          onArrowRight={() => sendTerminalText("\x1b[C")}
          onCtrlC={() => sendTerminalText("\x03")}
        />
      ) : null}
      <TextInput
        ref={keyboardDismissRef}
        style={styles.keyboardDismissSink}
        showSoftInputOnFocus={false}
        caretHidden
        autoCorrect={false}
        autoCapitalize="none"
      />

      {(isAlive || paneQuestion) && (
        <OptionButtons
          options={options}
          onSend={handleSend}
          autoYesActive={autoYesActive}
          onToggleAutoYes={handleToggleAutoYes}
          bottomInset={insets.bottom}
        />
      )}
    </View>
  );
}

function TerminalKeyboardToolbar({
  bottom,
  onDismiss,
  onEscape,
  onArrowUp,
  onArrowDown,
  onArrowLeft,
  onArrowRight,
  onCtrlC,
}: {
  bottom: number;
  onDismiss: () => void;
  onEscape: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onArrowLeft: () => void;
  onArrowRight: () => void;
  onCtrlC: () => void;
}) {
  return (
    <View style={[styles.keyboardToolbar, { bottom }]}>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onDismiss} activeOpacity={0.7}>
        <Ionicons name="close" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtnWide} onPress={onEscape} activeOpacity={0.7}>
        <Text style={styles.keyboardToolText}>Esc</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtnWide} onPress={onCtrlC} activeOpacity={0.7}>
        <Text style={styles.keyboardToolText}>C-c</Text>
      </TouchableOpacity>
      <View style={styles.keyboardToolSpacer} />
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowLeft} activeOpacity={0.7}>
        <Ionicons name="chevron-back" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowDown} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowUp} activeOpacity={0.7}>
        <Ionicons name="chevron-up" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowRight} activeOpacity={0.7}>
        <Ionicons name="chevron-forward" size={20} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

function TerminalScrollButtons({
  onScrollUp,
  onScrollDown,
  onExitCopyMode,
  copyModeActive,
}: {
  onScrollUp: () => void;
  onScrollDown: () => void;
  onExitCopyMode: () => void;
  copyModeActive: boolean;
}) {
  return (
    <View style={styles.scrollControls} pointerEvents="box-none">
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollUp} activeOpacity={0.7}>
        <View style={styles.scrollBtnVisible}>
          <Ionicons name="chevron-up" size={24} color={colors.text} />
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollDown} activeOpacity={0.7}>
        <View style={styles.scrollBtnVisible}>
          <Ionicons name="chevron-down" size={24} color={colors.text} />
        </View>
      </TouchableOpacity>
      {copyModeActive ? (
        <TouchableOpacity style={styles.exitCopyBtn} onPress={onExitCopyMode} activeOpacity={0.7}>
          <View style={styles.scrollBtnVisible}>
            <Ionicons name="close" size={24} color={colors.text} />
          </View>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function OptionButtons({
  options,
  onSend,
  autoYesActive,
  onToggleAutoYes,
  bottomInset = 0,
}: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  bottomInset?: number;
}) {
  if (options.length === 0) return null;
  const bottomPadding = Math.max(6, bottomInset + 10);
  const barHeight = bottomPadding + 34;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.optionBar, { height: barHeight, maxHeight: barHeight }]}
      contentContainerStyle={[styles.optionBarContent, { paddingBottom: bottomPadding }]}
    >
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.number}
          style={styles.optionBtn}
          onPress={() => {
            onSend(opt.number);
          }}
          activeOpacity={0.6}
        >
          <Text style={styles.optionBtnText}>
            {opt.number}. {opt.label.length > 25 ? opt.label.slice(0, 25) + "..." : opt.label}
          </Text>
        </TouchableOpacity>
      ))}
      {onToggleAutoYes && (
        <>
          <View style={styles.autoYesSeparator} />
          <TouchableOpacity
            style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
            onPress={onToggleAutoYes}
            activeOpacity={0.6}
          >
            <Text style={styles.autoYesBtnText} numberOfLines={1}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  notFound: { color: colors.textMuted, fontSize: 16 },
  headerRightSlot: {
    position: "relative",
    zIndex: 9999,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  contextBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  mobileContextMenu: {
    position: "absolute",
    top: 8,
    right: spacing.md,
    zIndex: 300,
    elevation: 300,
    minWidth: 160,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 4,
  },
  mobileContextBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 250,
    elevation: 250,
    backgroundColor: "transparent",
  },
  mobileContextItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  mobileContextText: {
    fontSize: 15,
    fontWeight: "600",
  },
  queryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  queryLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", width: 42 },
  queryText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 12, fontFamily: "monospace" },
  terminalContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    backgroundColor: TERMINAL_BG,
  },
  keyboardToolbar: {
    position: "absolute",
    left: 0,
    right: 0,
    height: KEYBOARD_TOOLBAR_HEIGHT,
    zIndex: 200,
    elevation: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  keyboardToolBtn: {
    width: 38,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyboardToolBtnWide: {
    minWidth: 48,
    height: 34,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyboardToolText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  keyboardToolSpacer: {
    flex: 1,
  },
  keyboardDismissSink: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    left: -10,
    bottom: 0,
  },
  scrollControls: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    zIndex: 100,
    elevation: 100,
    gap: 4,
  },
  scrollBtn: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  exitCopyBtn: {
    position: "absolute",
    left: -8,
    top: "50%",
    transform: [{ translateX: -64 }, { translateY: -32 }],
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollBtnVisible: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(28, 28, 30, 0.82)",
  },
  ptyConnecting: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ptyConnectingOverlay: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    zIndex: 90,
    elevation: 90,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(28, 28, 30, 0.88)",
  },
  ptyConnectingText: { color: colors.textMuted, fontSize: 12 },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  optionBar: {
    flexGrow: 0,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: "#303033",
    backgroundColor: TERMINAL_BG,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.32,
    shadowRadius: 16,
    elevation: 12,
  },
  optionBarContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: 6,
    alignItems: "center",
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
  autoYesSeparator: { width: 1, height: 18, backgroundColor: colors.border },
  autoYesBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  autoYesBtnActive: { backgroundColor: colors.warningBg },
  autoYesBtnText: { color: colors.warning, fontSize: 12, fontWeight: "600" },
});
