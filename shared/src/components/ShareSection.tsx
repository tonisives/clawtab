import { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export interface ShareInfo {
  id: string;
  email: string;
  display_name: string | null;
  allowed_groups: string[] | null;
}

export interface SharedWithMeInfo {
  id: string;
  owner_email: string;
  owner_display_name: string | null;
  allowed_groups: string[] | null;
}

export interface ShareSectionProps {
  sharedByMe: ShareInfo[];
  sharedWithMe: SharedWithMeInfo[];
  availableGroups: string[];
  loading?: boolean;
  onAdd: (email: string) => Promise<void>;
  onToggleGroup: (shareId: string, group: string) => void;
  onRemove: (shareId: string, email: string) => void;
  onLeave?: (shareId: string, ownerEmail: string) => void;
  formatGroup?: (group: string) => string;
}

export function ShareSection({
  sharedByMe,
  sharedWithMe,
  availableGroups,
  loading,
  onAdd,
  onToggleGroup,
  onRemove,
  onLeave,
  formatGroup = (g) => (g === "default" ? "General" : g),
}: ShareSectionProps) {
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingShareId, setEditingShareId] = useState<string | null>(null);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(trimmed);
      setEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Email address"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleAdd}
        />
        <Pressable
          style={[styles.addBtn, (adding || !email.trim()) && styles.btnDisabled]}
          onPress={handleAdd}
          disabled={adding || !email.trim()}
        >
          <Text style={styles.addBtnText}>
            {adding ? "..." : "Share"}
          </Text>
        </Pressable>
      </View>

      {error && (
        <Text style={styles.error}>{error}</Text>
      )}

      {loading && sharedByMe.length === 0 && sharedWithMe.length === 0 && (
        <Text style={styles.muted}>Loading...</Text>
      )}

      {sharedByMe.length > 0 && (
        <View style={styles.list}>
          {sharedByMe.map((share) => (
            <View key={share.id}>
              <View style={[
                styles.shareRow,
                editingShareId === share.id && styles.shareRowExpanded,
              ]}>
                <View style={styles.shareInfo}>
                  <Text style={styles.shareEmail}>{share.email}</Text>
                  {share.display_name && (
                    <Text style={styles.shareDisplayName}>{share.display_name}</Text>
                  )}
                  <Text style={styles.shareSummary}>
                    {share.allowed_groups === null
                      ? "All groups"
                      : `${share.allowed_groups.length} group${share.allowed_groups.length === 1 ? "" : "s"}`}
                  </Text>
                </View>
                <View style={styles.actions}>
                  <Pressable onPress={() => setEditingShareId(editingShareId === share.id ? null : share.id)}>
                    <Text style={styles.editText}>Groups</Text>
                  </Pressable>
                  <Pressable onPress={() => onRemove(share.id, share.email)}>
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
              </View>
              {editingShareId === share.id && availableGroups.length > 0 && (
                <View style={styles.groupPicker}>
                  {availableGroups.map((group) => {
                    const isSelected = share.allowed_groups === null || share.allowed_groups.includes(group);
                    return (
                      <Pressable
                        key={group}
                        style={[styles.groupChip, isSelected && styles.groupChipSelected]}
                        onPress={() => onToggleGroup(share.id, group)}
                      >
                        <Text style={[styles.groupChipText, isSelected && styles.groupChipTextSelected]}>
                          {formatGroup(group)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      {sharedWithMe.length > 0 && (
        <>
          <Text style={styles.subTitle}>Shared with me</Text>
          <View style={styles.list}>
            {sharedWithMe.map((share) => (
              <View key={share.id} style={styles.shareRow}>
                <View style={styles.shareInfo}>
                  <Text style={styles.shareEmail}>{share.owner_email}</Text>
                  {share.owner_display_name && (
                    <Text style={styles.shareDisplayName}>{share.owner_display_name}</Text>
                  )}
                </View>
                {onLeave && (
                  <Pressable onPress={() => onLeave(share.id, share.owner_email)}>
                    <Text style={styles.removeText}>Leave</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        </>
      )}

      {!loading && sharedByMe.length === 0 && sharedWithMe.length === 0 && (
        <Text style={styles.muted}>Not shared with anyone yet.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  inputRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    height: 36,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 13,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  addBtn: {
    height: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  addBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
  },
  muted: {
    color: colors.textMuted,
    fontSize: 13,
  },
  list: {
    gap: spacing.xs,
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shareRowExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
  },
  shareInfo: {
    flex: 1,
    minWidth: 0,
  },
  shareEmail: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
  },
  shareDisplayName: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 1,
  },
  shareSummary: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center",
  },
  editText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  removeText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "500",
  },
  subTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.xs,
  },
  groupPicker: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: colors.border,
  },
  groupChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  groupChipSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentBg,
  },
  groupChipText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  groupChipTextSelected: {
    color: colors.accent,
    fontWeight: "500",
  },
});
