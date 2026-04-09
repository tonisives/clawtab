import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { JobStatus } from "../types/job";
import type { DetectedProcess } from "../types/process";
import { StatusBadge } from "./StatusBadge";
import { ProcessCard } from "./ProcessCard";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function AgentSection({
  agentStatus,
  agentProcess,
  collapsed,
  onToggleCollapse,
  onRunAgent,
  onSelectProcess,
}: {
  agentStatus: JobStatus;
  agentProcess: DetectedProcess | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onRunAgent: (prompt: string) => void | Promise<void>;
  onSelectProcess?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const canRun = agentStatus.state === "idle" || agentStatus.state === "success" || agentStatus.state === "failed";
  const isWeb = Platform.OS === "web";

  const handleKeyDown = (e: any) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleRun();
    }
  };

  const handleRun = async () => {
    if (!prompt.trim() || sending) return;
    const nextPrompt = prompt.trim();
    setSending(true);
    try {
      await onRunAgent(nextPrompt);
      setPrompt("");
    } finally {
      setSending(false);
    }
  };

  return (
    <View>
      <TouchableOpacity
        onPress={onToggleCollapse}
        style={styles.headerRow}
        activeOpacity={0.6}
      >
        <Text style={styles.headerArrow}>
          {collapsed ? "\u25B6" : "\u25BC"}
        </Text>
        <Text style={styles.headerText}>Agent</Text>
        <View style={styles.headerRight}>
          <StatusBadge status={agentStatus} />
        </View>
      </TouchableOpacity>
      {!collapsed && (
        <>
          {agentProcess ? (
            <ProcessCard process={agentProcess} onPress={onSelectProcess} />
          ) : canRun ? (
            <View style={styles.agentSection}>
              <View style={styles.agentInput}>
                <TextInput
                  style={[
                    styles.agentTextInput,
                    isWeb &&
                      ({
                        resize: "vertical",
                        minHeight: 36,
                        maxHeight: 200,
                        outlineStyle: "none",
                      } as any),
                  ]}
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Enter a prompt for the agent..."
                  placeholderTextColor={colors.textMuted}
                  multiline
                  inputAccessoryViewID={Platform.OS === "ios" ? "keyboard-dismiss" : undefined}
                  editable={!sending}
                  {...(isWeb ? { onKeyDown: handleKeyDown } : {})}
                />
                <TouchableOpacity
                  style={[
                    styles.agentRunBtn,
                    (!prompt.trim() || sending) && styles.btnDisabled,
                  ]}
                  onPress={() => { void handleRun(); }}
                  disabled={!prompt.trim() || sending}
                  activeOpacity={0.7}
                >
                  <Text style={styles.agentRunBtnText}>Run</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  headerArrow: { fontFamily: "monospace", fontSize: 9, color: colors.textSecondary },
  headerText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: "auto" },
  agentSection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  agentInput: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  agentTextInput: {
    flex: 1,
    minHeight: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 13,
  },
  agentRunBtn: {
    height: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  agentRunBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
});
