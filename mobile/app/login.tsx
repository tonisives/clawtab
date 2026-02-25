import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useAuthStore } from "../src/store/auth";
import { colors } from "../src/theme/colors";
import { radius, spacing } from "../src/theme/spacing";

// Native-only: conditionally import Google Sign-In
let GoogleSignin: any = null;
let isSuccessResponse: any = null;
if (Platform.OS !== "web") {
  const mod = require("@react-native-google-signin/google-signin");
  GoogleSignin = mod.GoogleSignin;
  isSuccessResponse = mod.isSuccessResponse;
  GoogleSignin.configure({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
    offlineAccess: true,
  });
}

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const googleLogin = useAuthStore((s) => s.googleLogin);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("https://relay.clawtab.cc");
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Web: Google auth via expo-auth-session provider
  const [, googleResponse, promptAsync] = Google.useIdTokenAuthRequest({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
  });

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password, serverUrl || undefined);
      router.replace("/(tabs)");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      if (Platform.OS === "web") {
        const result = await promptAsync();
        if (result?.type === "success") {
          const idToken = result.params.id_token;
          if (idToken) {
            await googleLogin(idToken);
            router.replace("/(tabs)");
          } else {
            setError("No ID token received from Google");
          }
        } else if (result?.type === "error") {
          setError(result.error?.message ?? "Google sign-in failed");
        }
      } else {
        const response = await GoogleSignin.signIn();
        if (isSuccessResponse(response)) {
          const idToken = response.data.idToken;
          if (idToken) {
            await googleLogin(idToken);
            router.replace("/(tabs)");
          } else {
            const tokens = await GoogleSignin.getTokens();
            if (tokens.idToken) {
              await googleLogin(tokens.idToken);
              router.replace("/(tabs)");
            } else {
              setError("No ID token received from Google");
            }
          }
        }
      }
    } catch (e: any) {
      console.log("[google] error:", e.message, e.code);
      setError(e.message || "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title}>ClawTab</Text>
          <Text style={styles.subtitle}>Remote job control</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              editable={!loading}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="your password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              editable={!loading}
              onSubmitEditing={handleLogin}
            />
          </View>

          {showServer && (
            <View style={styles.field}>
              <Text style={styles.label}>Server URL</Text>
              <TextInput
                style={styles.input}
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="https://relay.clawtab.cc"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />
            </View>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading || !email.trim() || !password}
          >
            <Text style={styles.btnText}>
              {loading ? "Logging in..." : "Log in"}
            </Text>
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable
            style={[styles.googleBtn, loading && styles.btnDisabled]}
            onPress={handleGoogleLogin}
            disabled={loading}
          >
            <Text style={styles.googleBtnText}>Sign in with Google</Text>
          </Pressable>

          <View style={styles.links}>
            <Pressable onPress={() => router.push("/register")}>
              <Text style={styles.link}>Create account</Text>
            </Pressable>
            <Pressable onPress={() => setShowServer(!showServer)}>
              <Text style={styles.linkMuted}>
                {showServer ? "Hide server" : "Custom server"}
              </Text>
            </Pressable>
          </View>
        </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  card: {
    width: "100%",
    maxWidth: 400,
  },
  header: {
    alignItems: "center",
    marginBottom: spacing.xxl,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  form: {
    gap: spacing.lg,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  btn: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  googleBtn: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
    alignItems: "center",
  },
  googleBtnText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  links: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  link: {
    color: colors.accent,
    fontSize: 14,
  },
  linkMuted: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
