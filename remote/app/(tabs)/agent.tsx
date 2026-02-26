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
import * as api from "../../src/api/client";
import { alertError, openUrl } from "../../src/lib/platform";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

export default function AgentScreen() {
  const router = useRouter();
  const subscriptionRequired = useWsStore((s) => s.subscriptionRequired);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const { isWide } = useResponsive();

  const handleSubscribe = async () => {
    setSubLoading(true);
    try {
      const { url } = await api.createCheckout();
      await openUrl(url);
    } catch (e) {
      alertError("Error", String(e));
    } finally {
      setSubLoading(false);
    }
  };

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
      <ContentContainer>
        <View style={[styles.inner, isWide && styles.innerWide]}>
          {subscriptionRequired && (
            <View style={styles.subBanner}>
              <Text style={styles.subTitle}>Subscription required</Text>
              <Text style={styles.subText}>Subscribe to connect to your desktop and run agents remotely.</Text>
              <Pressable
                style={[styles.subBtn, subLoading && styles.btnDisabled]}
                onPress={handleSubscribe}
                disabled={subLoading}
              >
                <Text style={styles.subBtnText}>{subLoading ? "Loading..." : "Subscribe"}</Text>
              </Pressable>
            </View>
          )}

          <View style={[subscriptionRequired ? styles.demoOverlay : undefined, { pointerEvents: (subscriptionRequired ? "none" : "auto") as const }]}>
            <Text style={styles.heading}>Run Agent</Text>
            <Text style={styles.description}>
              Send a prompt to run a Claude agent on your desktop.
            </Text>

            <TextInput
              style={[styles.input, isWide && styles.inputWide]}
              value={subscriptionRequired ? "" : prompt}
              onChangeText={setPrompt}
              placeholder="What would you like the agent to do?"
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              editable={!sending && !subscriptionRequired}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.btn, (!prompt.trim() || sending || subscriptionRequired) && styles.btnDisabled, isWide && styles.btnWide]}
              onPress={handleRun}
              disabled={!prompt.trim() || sending || subscriptionRequired}
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
  subBanner: {
    alignItems: "center",
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  demoOverlay: {
    opacity: 0.35,
    gap: spacing.lg,
  },
  subTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  subText: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
  },
  subBtn: {
    height: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  subBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
