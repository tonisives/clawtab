import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator, Platform } from "react-native";
import * as api from "../api/client";
import * as storage from "../lib/storage";
import { alertError, confirm } from "../lib/platform";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const SECRETS_KEY = "clawtab_api_token_secrets";

async function loadSavedSecrets(): Promise<Record<string, string>> {
  try {
    const raw = await storage.getItem(SECRETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveSecrets(secrets: Record<string, string>): Promise<void> {
  await storage.setItem(SECRETS_KEY, JSON.stringify(secrets));
}

export function ApiTokensSection() {
  const [tokens, setTokens] = useState<api.ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [triggersUrl, setTriggersUrl] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const list = await api.listApiTokens();
      setTokens(list.filter((t) => !t.revoked_at));
    } catch (e) {
      console.error("Failed to load tokens:", e);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    api.getTriggersBaseUrl().then(setTriggersUrl);
    loadSavedSecrets().then(setSecrets);
  }, [refresh]);

  // Drop secrets for tokens that no longer exist (revoked or deleted elsewhere).
  useEffect(() => {
    if (loading || Object.keys(secrets).length === 0) return;
    const liveIds = new Set(tokens.map((t) => t.id));
    const cleaned = Object.fromEntries(
      Object.entries(secrets).filter(([id]) => liveIds.has(id)),
    );
    if (Object.keys(cleaned).length !== Object.keys(secrets).length) {
      setSecrets(cleaned);
      saveSecrets(cleaned);
    }
  }, [tokens, secrets, loading]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await api.createApiToken(trimmed);
      const next = { ...secrets, [created.id]: created.secret };
      setSecrets(next);
      await saveSecrets(next);
      setJustCreatedId(created.id);
      setRevealed((r) => ({ ...r, [created.id]: true }));
      setName("");
      setShowCreate(false);
      await refresh();
    } catch (e) {
      alertError("Error", e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = (token: api.ApiToken) => {
    confirm(
      "Revoke token",
      `Revoke "${token.name}"? Any system using this token will stop working.`,
      async () => {
        try {
          await api.revokeApiToken(token.id);
          if (secrets[token.id]) {
            const next = { ...secrets };
            delete next[token.id];
            setSecrets(next);
            await saveSecrets(next);
          }
          await refresh();
        } catch (e) {
          alertError("Error", e instanceof Error ? e.message : String(e));
        }
      },
    );
  };

  const handleForgetSecret = (id: string) => {
    confirm(
      "Forget secret",
      "Stop storing this token in the browser? The token stays valid; you just won't be able to copy it from here anymore.",
      async () => {
        const next = { ...secrets };
        delete next[id];
        setSecrets(next);
        await saveSecrets(next);
        setRevealed((r) => {
          const n = { ...r };
          delete n[id];
          return n;
        });
      },
    );
  };

  const copyToClipboard = async (id: string, text: string) => {
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>API Tokens</Text>
      <Text style={styles.helpText}>
        Trigger jobs and agents on your desktop from CI, n8n, Zapier, or your own scripts. Tokens
        are shown only once on creation.
      </Text>

      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : tokens.length === 0 ? (
        <View style={styles.row}>
          <Text style={styles.emptyText}>No tokens yet</Text>
        </View>
      ) : (
        tokens.map((t) => {
          const savedSecret = secrets[t.id];
          const isRevealed = !!revealed[t.id];
          const isJustCreated = justCreatedId === t.id;
          return (
            <View key={t.id} style={styles.tokenCard}>
              <View style={styles.tokenRow}>
                <View style={{ flex: 1 }}>
                  <View style={styles.nameRow}>
                    <Text style={styles.tokenName}>{t.name}</Text>
                    {isJustCreated && (
                      <View style={styles.newBadge}>
                        <Text style={styles.newBadgeText}>NEW</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.tokenMeta} numberOfLines={1}>
                    {t.prefix}... created {new Date(t.created_at).toLocaleDateString()}
                    {t.last_used_at ? `  last used ${new Date(t.last_used_at).toLocaleDateString()}` : "  never used"}
                  </Text>
                </View>
                <Pressable style={styles.revokeBtn} onPress={() => handleRevoke(t)}>
                  <Text style={styles.revokeText}>Revoke</Text>
                </Pressable>
              </View>

              {savedSecret && (
                <View style={styles.secretRow}>
                  <Text style={styles.secretText} selectable numberOfLines={1}>
                    {isRevealed ? savedSecret : `${t.prefix}${"•".repeat(24)}`}
                  </Text>
                  <Pressable
                    style={styles.toggleBtn}
                    onPress={() => setRevealed((r) => ({ ...r, [t.id]: !r[t.id] }))}
                  >
                    <Text style={styles.toggleBtnText}>{isRevealed ? "Hide" : "Show"}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.copyBtn}
                    onPress={() => copyToClipboard(t.id, savedSecret)}
                  >
                    <Text style={styles.copyBtnText}>{copiedId === t.id ? "Copied!" : "Copy"}</Text>
                  </Pressable>
                </View>
              )}

              {savedSecret && (
                <Pressable onPress={() => handleForgetSecret(t.id)} style={styles.forgetBtn}>
                  <Text style={styles.forgetText}>Forget secret on this device</Text>
                </Pressable>
              )}
            </View>
          );
        })
      )}

      {showCreate ? (
        <View style={styles.createForm}>
          <TextInput
            style={styles.input}
            placeholder="Token name (e.g. n8n production)"
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={setName}
            autoFocus
            editable={!creating}
            onSubmitEditing={handleCreate}
          />
          <View style={styles.formButtons}>
            <Pressable
              style={styles.cancelBtn}
              onPress={() => { setShowCreate(false); setName(""); }}
              disabled={creating}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.createBtn, (!name.trim() || creating) && styles.btnDisabled]}
              onPress={handleCreate}
              disabled={!name.trim() || creating}
            >
              <Text style={styles.createBtnText}>{creating ? "Creating..." : "Create"}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.addBtn} onPress={() => setShowCreate(true)}>
          <Text style={styles.addBtnText}>+ New token</Text>
        </Pressable>
      )}

      <View style={styles.usageBlock}>
        <Text style={styles.usageTitle}>How to call it</Text>
        <Text style={styles.codeBlock} selectable>
{`curl -X POST ${triggersUrl || "https://triggers.clawtab.cc"}/v1/triggers/run \\
  -H 'Authorization: Bearer ctk_...' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "agent": {
      "prompt": "echo hello > $CLAWTAB_RESULT_FILE",
      "work_dir": "/tmp/cwt-test"
    },
    "wait": true,
    "timeout_ms": 30000
  }'`}
        </Text>
        <Text style={styles.usageNote}>
          Or trigger an existing job by name: {`{"job":"my-job-slug"}`}. The desktop writes
          structured results to $CLAWTAB_RESULT_FILE; that JSON comes back in the response.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  helpText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: "italic",
  },
  tokenCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  newBadge: {
    backgroundColor: colors.success,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  newBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  tokenName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  tokenMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  revokeBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  revokeText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  createForm: {
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 14,
    backgroundColor: colors.bg,
  },
  formButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  cancelBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  createBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  createBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  addBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    alignItems: "center",
  },
  addBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "500",
  },
  secretRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  secretText: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontFamily: Platform.select({ web: "monospace", default: "Menlo" }),
  },
  toggleBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  copyBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    minWidth: 64,
    alignItems: "center",
  },
  copyBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  forgetBtn: {
    alignSelf: "flex-start",
  },
  forgetText: {
    color: colors.textMuted,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  usageBlock: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  usageTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  codeBlock: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 12,
    fontFamily: Platform.select({ web: "monospace", default: "Menlo" }),
    lineHeight: 18,
  },
  usageNote: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
});
