import { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { useWsStore } from "../../src/store/ws";
import { useJobsStore } from "../../src/store/jobs";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { registerRequest } from "../../src/lib/useRequestMap";
import { openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";
import { AgentSelector } from "@clawtab/shared";
import type { AgentModelOption, AgentSelection, DetectedProcess, ProcessProvider } from "@clawtab/shared";
import { BARE_PROVIDER_OPTIONS, buildModelOptions } from "../../src/lib/agentModels";

const STORAGE_KEY = "clawtab_agent_selection_v3";
const LEGACY_STORAGE_KEY = "clawtab_agent_model_v2";

const DEFAULT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity"];
// Start with the provider entry; the shared current catalog and server-pushed models
// populate the concrete choices in the selector.
const DEFAULT_MODEL: AgentModelOption =
  BARE_PROVIDER_OPTIONS.find((m) => m.provider === "claude") ?? BARE_PROVIDER_OPTIONS[0];
const DEFAULT_SELECTION: AgentSelection = { provider: DEFAULT_MODEL.provider, modelId: DEFAULT_MODEL.modelId, effort: null };

function isProcessProvider(value: string | undefined): value is ProcessProvider {
  return value === "claude" || value === "codex" || value === "opencode" || value === "antigravity" || value === "shell";
}

function getStoredSelection(): AgentSelection {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return DEFAULT_SELECTION;
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return DEFAULT_SELECTION;
    const parsed = JSON.parse(raw) as Partial<AgentSelection>;
    if (parsed.provider && "modelId" in parsed) {
      return { provider: parsed.provider, modelId: parsed.modelId ?? null, effort: parsed.effort ?? null };
    }
  } catch { /* ignore */ }
  return DEFAULT_SELECTION;
}

function storeSelection(selection: AgentSelection) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export default function AgentScreen() {
  const router = useRouter();
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const connected = useWsStore((s) => s.connected);
  const enabledModels = useJobsStore((s) => s.enabledModels);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSelection, setSelectedSelection] = useState<AgentSelection>(getStoredSelection);
  const selectedSelectionRef = useRef(selectedSelection);
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const inputRef = useRef<any>(null);
  const { isWide } = useResponsive();

  const getTextarea = useCallback((): HTMLTextAreaElement | null => {
    const node = inputRef.current;
    if (!node) return null;
    if (node instanceof HTMLTextAreaElement) return node;
    // React Native Web may expose the DOM node via _node or _nativeNode
    const direct = node._node ?? node._nativeNode;
    if (direct instanceof HTMLTextAreaElement) return direct;
    if (direct?.querySelector) return direct.querySelector("textarea");
    // Fallback: try treating the ref as a DOM-like container
    if (node.querySelector) return node.querySelector("textarea");
    return null;
  }, []);

  const adjustHeight = useCallback(() => {
    if (Platform.OS !== "web") return;
    const el = getTextarea();
    if (!el) return;
    const min = isWide ? 200 : 120;
    const max = isWide ? 400 : 300;
    // Collapse to 0 so scrollHeight reflects actual content, not current box
    el.style.height = "0px";
    const needed = el.scrollHeight;
    const clamped = Math.min(max, Math.max(min, needed));
    el.style.height = `${clamped}px`;
    setInputHeight(clamped);
  }, [isWide, getTextarea]);

  useEffect(() => {
    adjustHeight();
  }, [prompt, adjustHeight]);

  const modelOptions = buildModelOptions(DEFAULT_PROVIDERS, enabledModels ?? {});

  const handleSelectAgent = (selection: AgentSelection) => {
    selectedSelectionRef.current = selection;
    setSelectedSelection(selection);
    storeSelection(selection);
  };

  const handleRun = async () => {
    if (!prompt.trim()) return;
    const send = getWsSend();
    if (!send) {
      setError("Not connected");
      return;
    }

    setSending(true);
    setError(null);
    const promptText = prompt.trim();
    const launchSelection = selectedSelectionRef.current;
    const provider = launchSelection.provider;
    const model = launchSelection.modelId ?? undefined;

    const msgId = nextId();
    send({
      type: "run_agent",
      id: msgId,
      prompt: promptText,
      provider,
      model,
      ...(launchSelection.effort ? { effort: launchSelection.effort } : {}),
    });

    try {
      const ack = await registerRequest<{
        success?: boolean;
        job_id?: string;
        pane_id?: string;
        tmux_session?: string;
        work_dir?: string;
        provider?: string;
        error?: string;
      }>(msgId);
      if (ack.success === false) {
        setError(ack.error ?? "Failed to start agent");
        return;
      }

      if (ack.pane_id && ack.tmux_session) {
        const resolvedProvider = isProcessProvider(ack.provider) ? ack.provider : provider;
        const process: DetectedProcess = {
          pane_id: ack.pane_id,
          cwd: ack.work_dir ?? "",
          version: "",
          provider: resolvedProvider,
          can_fork_session: false,
          can_send_skills: false,
          can_inject_secrets: false,
          tmux_session: ack.tmux_session,
          window_name: "",
          matched_group: null,
          matched_job: ack.job_id ?? null,
          log_lines: "",
          first_query: promptText,
          last_query: null,
          session_started_at: new Date().toISOString(),
          token_count: null,
          _transient_state: "starting",
        };
        useJobsStore.getState().upsertDetectedProcess(process);
        setPrompt("");
        setInputHeight(undefined);
        router.replace(`/process/${ack.pane_id.replace(/%/g, "_pct_")}`);
        return;
      }

      if (ack.job_id) {
        setPrompt("");
        setInputHeight(undefined);
        router.replace(`/job/${ack.job_id}`);
        return;
      }

      setError("Agent started, but no terminal pane was returned");
    } catch {
      setError("Failed to start agent");
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={90}
    >
      <ContentContainer fill>
        <View style={[styles.inner, isWide && styles.innerWide]}>
          {connected && !desktopOnline && (
            <View style={styles.offlineBanner}>
              <Text style={styles.offlineTitle}>Desktop not connected</Text>
              <Text style={styles.offlineText}>Please install ClawTab desktop and sign in to same account.</Text>
              <Pressable onPress={() => openUrl("https://clawtab.cc/docs#quick-start")}>
                <Text style={styles.linkText}>Quick Start Guide</Text>
              </Pressable>
            </View>
          )}

          <View>
            <Text style={styles.heading}>Run Agent</Text>
            <Text style={styles.description}>
              Send a prompt to run an agent on your desktop.
            </Text>

            <TextInput
              ref={inputRef}
              style={[styles.input, isWide && styles.inputWide, inputHeight != null && { height: inputHeight }]}
              value={prompt}
              onChangeText={setPrompt}
              placeholder="What would you like the agent to do?"
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              editable={!sending && desktopOnline}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={[styles.bottomRow, isWide && styles.bottomRowWide]}>
              <AgentSelector
                modelOptions={modelOptions}
                provider={selectedSelection.provider}
                model={selectedSelection.modelId}
                effort={selectedSelection.effort}
                mode="button"
                label="Choose agent"
                disabled={sending || !desktopOnline}
                onChange={handleSelectAgent}
              />

              <Pressable
                style={[styles.btn, (!prompt.trim() || sending || !desktopOnline) && styles.btnDisabled]}
                onPress={handleRun}
                disabled={!prompt.trim() || sending || !desktopOnline}
              >
                <Text style={styles.btnText}>
                  {sending ? "Sending..." : "Run Agent"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </ContentContainer>

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  inner: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  innerWide: {
    paddingTop: 48,
  },
  heading: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  input: {
    minHeight: 120,
    maxHeight: 300,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  inputWide: {
    minHeight: 200,
    maxHeight: 400,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  bottomRow: {
    flexDirection: "column",
    gap: spacing.sm,
  },
  bottomRowWide: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  btn: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    alignSelf: "flex-start",
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  offlineBanner: {
    alignItems: "center",
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  offlineTitle: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: "600",
  },
  offlineText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  linkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "500",
  },
});
