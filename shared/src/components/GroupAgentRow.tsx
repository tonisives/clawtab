import { useState } from "react";
import { View, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function GroupAgentRow({
  onRunAgent,
}: {
  onRunAgent: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);

  const handleRun = () => {
    if (!prompt.trim() || sending) return;
    setSending(true);
    onRunAgent(prompt.trim());
    setPrompt("");
    setSending(false);
  };

  return (
    <View style={styles.row}>
      <TextInput
        style={styles.input}
        value={prompt}
        onChangeText={setPrompt}
        placeholder="Run agent in this folder..."
        placeholderTextColor={colors.textMuted}
        returnKeyType="send"
        onSubmitEditing={handleRun}
        editable={!sending}
      />
      <TouchableOpacity
        style={[styles.btn, (!prompt.trim() || sending) && styles.btnDisabled]}
        onPress={handleRun}
        disabled={!prompt.trim() || sending}
        activeOpacity={0.7}
      >
        <View style={styles.btnIcon}>
          <View style={styles.triangle} />
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    alignItems: "center",
    paddingHorizontal: spacing.xs,
  },
  input: {
    flex: 1,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 12,
  },
  btn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  btnIcon: {
    width: 12,
    height: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  triangle: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftColor: "#fff",
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    marginLeft: 2,
  },
  btnDisabled: { opacity: 0.5 },
});
