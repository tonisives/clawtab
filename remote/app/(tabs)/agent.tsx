import { useState } from "react";
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
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { useWsStore } from "../../src/store/ws";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

export default function AgentScreen() {
  const router = useRouter();
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const connected = useWsStore((s) => s.connected);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isWide } = useResponsive();

  const handleRun = () => {
    if (!prompt.trim()) return;
    const send = getWsSend();
    if (!send) {
      setError("Not connected");
      return;
    }

    setSending(true);
    setError(null);

    send({ type: "run_agent", id: nextId(), prompt: prompt.trim() });
    setPrompt("");
    setSending(false);
    router.push("/(tabs)");
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
              Send a prompt to run a Claude agent on your desktop.
            </Text>

            <TextInput
              style={[styles.input, isWide && styles.inputWide]}
              value={prompt}
              onChangeText={setPrompt}
              placeholder="What would you like the agent to do?"
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              editable={!sending && desktopOnline}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.btn, (!prompt.trim() || sending || !desktopOnline) && styles.btnDisabled, isWide && styles.btnWide]}
              onPress={handleRun}
              disabled={!prompt.trim() || sending || !desktopOnline}
            >
              <Text style={styles.btnText}>
                {sending ? "Sending..." : "Run Agent"}
              </Text>
            </Pressable>
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
  },
  description: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  input: {
    flex: 1,
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
  },
  inputWide: {
    minHeight: 200,
    maxHeight: 400,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  btn: {
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  btnWide: {
    alignSelf: "flex-start",
    paddingHorizontal: 48,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
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
