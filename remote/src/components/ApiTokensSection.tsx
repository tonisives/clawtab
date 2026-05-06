import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator, Platform } from "react-native";
import * as api from "../api/client";
import { alertError, confirm } from "../lib/platform";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function ApiTokensSection() {
  const [tokens, setTokens] = useState<api.ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<api.CreatedApiToken | null>(null);
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
  }, [refresh]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await api.createApiToken(trimmed);
      setJustCreated(created);
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
          await refresh();
        } catch (e) {
          alertError("Error", e instanceof Error ? e.message : String(e));
        }
      },
    );
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
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

      {justCreated && (
        <View style={styles.createdCard}>
          <Text style={styles.createdLabel}>New token (copy now, you won't see it again):</Text>
          <View style={styles.secretRow}>
            <Text style={styles.secretText} selectable numberOfLines={1}>
              {justCreated.secret}
            </Text>
            <Pressable
              style={styles.copyBtn}
              onPress={() => copyToClipboard(justCreated.secret)}
            >
              <Text style={styles.copyBtnText}>Copy</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => setJustCreated(null)} style={styles.dismissBtn}>
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : tokens.length === 0 ? (
        <View style={styles.row}>
          <Text style={styles.emptyText}>No tokens yet</Text>
        </View>
      ) : (
        tokens.map((t) => (
          <View key={t.id} style={styles.tokenRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.tokenName}>{t.name}</Text>
              <Text style={styles.tokenMeta} numberOfLines={1}>
                {t.prefix}... created {new Date(t.created_at).toLocaleDateString()}
                {t.last_used_at ? `  last used ${new Date(t.last_used_at).toLocaleDateString()}` : "  never used"}
              </Text>
            </View>
            <Pressable style={styles.revokeBtn} onPress={() => handleRevoke(t)}>
              <Text style={styles.revokeText}>Revoke</Text>
            </Pressable>
          </View>
        ))
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
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
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
  createdCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.success,
    gap: spacing.sm,
  },
  createdLabel: {
    color: colors.success,
    fontSize: 13,
    fontWeight: "600",
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
  copyBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  copyBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  dismissBtn: {
    alignSelf: "flex-end",
  },
  dismissText: {
    color: colors.textMuted,
    fontSize: 12,
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
