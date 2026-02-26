import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Modal, StyleSheet } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function ParamsDialog({
  jobName,
  params,
  visible,
  onRun,
  onCancel,
}: {
  jobName: string;
  params: string[];
  visible: boolean;
  onRun: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const p of params) v[p] = "";
    return v;
  });

  const allFilled = params.every((k) => values[k]?.trim());

  const handleRun = () => {
    if (allFilled) onRun(values);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          <Text style={styles.title}>Run: {jobName}</Text>
          <Text style={styles.hint}>Fill in all parameters before running.</Text>
          {params.map((key) => (
            <View key={key} style={styles.paramRow}>
              <Text style={styles.paramLabel}>{key}</Text>
              <TextInput
                style={styles.paramInput}
                value={values[key] ?? ""}
                onChangeText={(text) => setValues((prev) => ({ ...prev, [key]: text }))}
                placeholder={`{${key}}`}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          ))}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.runBtn, !allFilled && { opacity: 0.4 }]}
              onPress={handleRun}
              disabled={!allFilled}
            >
              <Text style={styles.runText}>Run</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  content: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    width: "100%",
    maxWidth: 400,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 16,
  },
  paramRow: {
    marginBottom: 12,
  },
  paramLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 4,
  },
  paramInput: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: "monospace",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: 8,
  },
  cancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  runBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  runText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});
