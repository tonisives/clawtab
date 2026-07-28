import { useCallback, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { spacing } from "../theme/spacing";
import type { AgentEffort, AgentModelOption, ProcessProvider } from "../types/process";
import { AgentSelector } from "./AgentSelector";

export function GroupAgentRow({
  onRunAgent,
  modelOptions = [],
  provider,
  model,
  effort,
  workDir,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null, effort?: AgentEffort | null) => void | Promise<void>;
  provider?: ProcessProvider | null;
  model?: string | null;
  effort?: AgentEffort | null;
  modelOptions?: AgentModelOption[];
  workDir?: string;
}) {
  const sendingRef = useRef(false);

  const launch = useCallback(async (nextProvider: ProcessProvider, modelId: string | null, nextEffort: AgentEffort | null) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      await onRunAgent("", nextProvider, modelId, nextEffort);
    } finally {
      sendingRef.current = false;
    }
  }, [onRunAgent]);

  return (
    <View
      style={styles.row}
      {...(Platform.OS === "web" && workDir ? { dataSet: { agentWorkdir: workDir } } : {})}
    >
      <AgentSelector
        mode="plus"
        provider={provider}
        model={model}
        effort={effort}
        modelOptions={modelOptions}
        includeShell
        onChange={(selection) => launch(selection.provider, selection.modelId, selection.effort)}
        nativeBottomInset={88}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: Platform.OS === "web" ? spacing.xs : spacing.md,
    paddingVertical: Platform.OS === "web" ? 2 : spacing.sm,
  },
});
