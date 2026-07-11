import { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
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
import { JobKindIcon, PopupMenu } from "@clawtab/shared";
import type { ProcessProvider, AgentModelOption, DetectedProcess } from "@clawtab/shared";
import { BARE_PROVIDER_OPTIONS, buildModelOptions, labelForProviderModel } from "../../src/lib/agentModels";

const STORAGE_KEY = "clawtab_agent_model_v2";

const DEFAULT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity"];
// Bare claude entry; the actual model gets resolved from server-pushed enabled_models.
const DEFAULT_MODEL: AgentModelOption =
  BARE_PROVIDER_OPTIONS.find((m) => m.provider === "claude") ?? BARE_PROVIDER_OPTIONS[0];

function isProcessProvider(value: string | undefined): value is ProcessProvider {
  return value === "claude" || value === "codex" || value === "opencode" || value === "antigravity" || value === "shell";
}

function getStoredModel(): AgentModelOption {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return DEFAULT_MODEL;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MODEL;
    const parsed = JSON.parse(raw) as AgentModelOption;
    if (parsed.provider && "modelId" in parsed) return parsed;
  } catch { /* ignore */ }
  return DEFAULT_MODEL;
}

function storeModel(opt: AgentModelOption) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(opt));
}

export default function AgentScreen() {
  const router = useRouter();
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const connected = useWsStore((s) => s.connected);
  const enabledModels = useJobsStore((s) => s.enabledModels);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<AgentModelOption>(getStoredModel);
  const selectedModelRef = useRef(selectedModel);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const providerBtnRef = useRef<any>(null);
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

  const DEFAULT_ENABLED = {
    claude: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-8"],
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    opencode: [] as string[],
    antigravity: [] as string[],
  };
  const resolvedModels = (!enabledModels || Object.keys(enabledModels).length === 0) ? DEFAULT_ENABLED : enabledModels;
  const modelOptions = buildModelOptions(DEFAULT_PROVIDERS, resolvedModels);

  const handleSelectModel = (opt: AgentModelOption) => {
    selectedModelRef.current = opt;
    setSelectedModel(opt);
    storeModel(opt);
    setMenuOpen(false);
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
    const launchModel = selectedModelRef.current;
    const provider = launchModel.provider;
    const model = launchModel.modelId ?? undefined;

    const msgId = nextId();
    send({
      type: "run_agent",
      id: msgId,
      prompt: promptText,
      provider,
      model,
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

  const modelLabel = labelForProviderModel(selectedModel.provider, selectedModel.modelId);

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
              <TouchableOpacity
                ref={providerBtnRef}
                style={styles.modelBtn}
                onPress={(e: any) => {
                  if (Platform.OS === "web") {
                    const node = e?.currentTarget ?? e?.target;
                    if (node?.getBoundingClientRect) {
                      const rect = node.getBoundingClientRect();
                      setMenuPos({ top: rect.bottom + 6, left: rect.right });
                    }
                  }
                  setMenuOpen((v) => !v);
                }}
                activeOpacity={0.7}
              >
                <JobKindIcon kind={selectedModel.provider} size={16} compact bare />
                <Text style={styles.modelBtnText} numberOfLines={1}>{modelLabel}</Text>
                <Text style={styles.modelBtnCaret}>{"\u25BE"}</Text>
              </TouchableOpacity>

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

      {menuOpen && (
        <PopupMenu
          triggerRef={providerBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          autoFocus
          items={modelOptions.map((opt) => ({
            type: "item" as const,
            label: opt.label,
            active: opt.provider === selectedModel.provider && opt.modelId === selectedModel.modelId,
            icon: <JobKindIcon kind={opt.provider} size={16} compact bare />,
            onPress: () => handleSelectModel(opt),
          }))}
        />
      )}
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
  modelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: "flex-start",
  },
  modelBtnText: {
    fontSize: 13,
    color: colors.text,
    flexShrink: 1,
  },
  modelBtnCaret: {
    color: colors.textMuted,
    fontSize: 10,
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
