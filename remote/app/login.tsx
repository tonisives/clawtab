import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
  Modal,
  KeyboardAvoidingView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGoogleBrowserAuth } from "../src/lib/googleBrowserAuth";
import { googleIosClientId } from "../src/lib/googleIosClientId";
import { useAuthStore } from "../src/store/auth";
import * as api from "../src/api/client";
import { colors } from "../src/theme/colors";
import { radius, spacing } from "../src/theme/spacing";
import { StartupLoginMark } from "../src/components/StartupTransition";
import { startupBackground } from "../src/lib/clawArrivalDocument";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const APPLE_WEB_CLIENT_ID = "cc.clawtab.web";

// Native-only: conditionally import Google Sign-In
let GoogleSignin: any = null;
let isSuccessResponse: any = null;
if (Platform.OS !== "web") {
  try {
    const mod = require("@react-native-google-signin/google-signin");
    GoogleSignin = mod.GoogleSignin;
    isSuccessResponse = mod.isSuccessResponse;
    GoogleSignin.configure({
      iosClientId: googleIosClientId,
      ...(process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB
        ? { webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB, offlineAccess: true }
        : {}),
    });
  } catch {
    GoogleSignin = null;
    isSuccessResponse = null;
  }
}

// Native-only: conditionally import Apple Authentication
let AppleAuthentication: any = null;
if (Platform.OS === "ios") {
  AppleAuthentication = require("expo-apple-authentication");
}

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  let { return_to, setup } = useLocalSearchParams<{ return_to?: string; setup?: string }>();
  let destination = return_to === "workspace" ? "/workspace" as const : return_to === "add-machine" ? { pathname: "/add-machine" as const, params: { setup: setup === "connect" || setup === "rent" ? setup : undefined } } : return_to === "account" ? "/account" as const : ["devices", "machines"].includes(return_to ?? "") ? "/machines" as const : "/(tabs)" as const;
  const googleLogin = useAuthStore((s) => s.googleLogin);
  const passwordLogin = useAuthStore((s) => s.passwordLogin);
  const appleLogin = useAuthStore((s) => s.appleLogin);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState("https://relay.clawtab.cc");
  const [tempServerUrl, setTempServerUrl] = useState("");

  useEffect(() => { void api.getServerUrl().then(setServerUrl); }, []);

  // The prompt promise completes once the root handles the browser callback.
  const [, , promptAsync] = useGoogleBrowserAuth({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB,
    iosClientId: googleIosClientId,
  });

  const completeGoogleLogin = useCallback(async (idToken: string) => {
    await googleLogin(idToken);
    router.replace(destination);
  }, [googleLogin, router, destination]);

  const handlePasswordLogin = async () => {
    if (loading) return;
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await passwordLogin(email.trim(), password);
      setPassword("");
      router.replace(destination);
    } catch (e: any) {
      setError(e.status === 401 ? "Email or password is incorrect." : e.message || "Sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      if (Platform.OS === "web" || !GoogleSignin || !isSuccessResponse) {
        const result = await promptAsync();
        if (result?.type === "success") {
          const idToken = result.params.id_token;
          if (idToken) {
            await completeGoogleLogin(idToken);
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
            await completeGoogleLogin(idToken);
          } else {
            const tokens = await GoogleSignin.getTokens();
            if (tokens.idToken) {
              await completeGoogleLogin(tokens.idToken);
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

  const toBase64Url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const setAuth = useAuthStore((s) => s.setAuth);

  const pollForAuthResult = useCallback(async (sessionId: string) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const resp = await fetch(`${serverUrl}/auth/session/${sessionId}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.status === "complete") {
          await api.storeTokens(data.access_token, data.refresh_token, data.user_id);
          setAuth(data.user_id, data.access_token);
          router.replace(destination);
          return true;
        }
      } catch {
        // keep polling
      }
    }
    return false;
  }, [serverUrl, router, setAuth, destination]);

  const handleAppleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      if (Platform.OS === "web") {
        const sessionId = crypto.randomUUID();
        const state = toBase64Url(`clawtab:${sessionId}`);
        await fetch(`${serverUrl}/auth/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => {});
        const redirectUri = `${serverUrl}/auth/apple/callback`;
        const params = new URLSearchParams({
          client_id: APPLE_WEB_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code id_token",
          response_mode: "form_post",
          scope: "name email",
          state,
        });
        window.open(`https://appleid.apple.com/auth/authorize?${params}`, "_blank");
        const ok = await pollForAuthResult(sessionId);
        if (!ok) setError("Apple sign-in timed out");
      } else {
        if (!AppleAuthentication) return;
        const credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
        });
        if (credential.identityToken) {
          const name = [credential.fullName?.givenName, credential.fullName?.familyName]
            .filter(Boolean)
            .join(" ") || undefined;
          await appleLogin(credential.identityToken, name, credential.email ?? undefined);
          router.replace(destination);
        } else {
          setError("No identity token received from Apple");
        }
      }
    } catch (e: any) {
      if (e.code !== "ERR_REQUEST_CANCELED") {
        setError(e.message || "Apple sign-in failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.card}>
        <View style={styles.header}>
          <StartupLoginMark />
          <Text style={styles.title}>ClawTab</Text>
          <Text style={styles.subtitle}>Remote job control</Text>
        </View>

        <View style={styles.form}>
          {error && <Text style={styles.error}>{error}</Text>}

          {(Platform.OS === "ios" || Platform.OS === "web") && (
            <Pressable
              style={[styles.appleBtn, loading && styles.btnDisabled]}
              onPress={handleAppleLogin}
              disabled={loading}
            >
              <Text style={styles.appleBtnText}>Sign in with Apple</Text>
            </Pressable>
          )}

          <Pressable
            style={[styles.googleBtn, loading && styles.btnDisabled]}
            onPress={handleGoogleLogin}
            disabled={loading}
          >
            <Text style={styles.googleBtnText}>Sign in with Google</Text>
          </Pressable>

          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showEmail }} onPress={() => setShowEmail(!showEmail)} disabled={loading} style={[styles.emailToggle, loading && styles.btnDisabled]}>
            <Text style={styles.emailToggleText}>Sign in with email</Text>
          </Pressable>

          {showEmail && (
            <View style={styles.emailForm}>
              <TextInput
                accessibilityLabel="Email"
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="username"
                textContentType="username"
                editable={!loading}
              />
              <TextInput
                accessibilityLabel="Password"
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                editable={!loading}
                onSubmitEditing={handlePasswordLogin}
                returnKeyType="go"
              />
              <Pressable accessibilityRole="button" onPress={handlePasswordLogin} disabled={loading} style={[styles.googleBtn, loading && styles.btnDisabled]}>
                <Text style={styles.googleBtnText}>Sign in</Text>
              </Pressable>
            </View>
          )}

          {Platform.OS === "android" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/demo")}
              disabled={loading}
              style={[styles.googleBtn, loading && styles.btnDisabled]}
            >
              <Text style={styles.googleBtnText}>Try demo</Text>
            </Pressable>
          )}

          <Pressable onPress={() => { setTempServerUrl(serverUrl); setShowServer(true); }}>
            <Text style={styles.serverText}>
              Server: {serverUrl}
            </Text>
          </Pressable>
        </View>
      </View>

      <Modal
        visible={showServer}
        transparent
        animationType="fade"
        onRequestClose={() => setShowServer(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowServer(false)}>
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={tempServerUrl}
              onChangeText={setTempServerUrl}
              placeholder="https://relay.clawtab.cc"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <Pressable
                style={styles.modalBtn}
                onPress={() => setShowServer(false)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={async () => {
                  try { setServerUrl(await api.setServerUrl(tempServerUrl)); setShowServer(false); setError(null); }
                  catch (error: any) { setShowServer(false); setError(error.message); }
                }}
              >
                <Text style={[styles.modalBtnText, styles.modalBtnPrimaryText]}>Save</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    backgroundColor: startupBackground,
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
  emailForm: {
    gap: spacing.md,
  },
  emailToggle: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  emailToggleText: { color: colors.textSecondary, fontSize: 13 },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  googleBtn: {
    height: 44,
    borderRadius: 999,
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
  appleBtn: {
    height: 44,
    borderRadius: 999,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  appleBtnText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  serverText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
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
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  modalContent: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.md,
  },
  modalBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 999,
  },
  modalBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "500",
  },
  modalBtnPrimary: {
    backgroundColor: colors.accent,
  },
  modalBtnPrimaryText: {
    color: "#fff",
  },
});
