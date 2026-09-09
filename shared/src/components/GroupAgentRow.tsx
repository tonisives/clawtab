import { useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { spacing } from "../theme/spacing";
import type { AgentEffort, AgentModelOption, ProcessProvider } from "../types/process";
import { useMachines, selectMachine } from "../machines/client";
import { buildModelOptions } from "../util/agentModels";
import type { PopupMenuItem } from "./PopupMenu";
import { colors } from "../theme/colors";
import { AgentSelector } from "./AgentSelector";

export function GroupAgentRow({
  onRunAgent,
  modelOptions = [],
  provider,
  model,
  effort,
  workDir,
  localMachineId,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null, effort?: AgentEffort | null) => void | Promise<void>;
  provider?: ProcessProvider | null;
  model?: string | null;
  effort?: AgentEffort | null;
  modelOptions?: AgentModelOption[];
  workDir?: string;
  localMachineId?: string | null;
}) {
  const sendingRef = useRef(false);
  let machines = useMachines();
  let [busy, setBusy] = useState(false);
  let [error, setError] = useState<string | null>(null);
  let hasLocal = localMachineId !== undefined;
  let target = machines.selected ?? localMachineId ?? (hasLocal ? null : machines.machines.find((machine) => machine.online && machine.owned)?.id);
  let isLocal = hasLocal && (target == null || target === localMachineId);
  let machine = machines.machines.find((machine) => machine.id === target);
  let settings = target ? machines.snapshots[target]?.settings_response : undefined;
  let options = isLocal ? modelOptions : settings
    ? buildModelOptions(["claude", "codex", "opencode", "antigravity"], settings.enabled_models ?? {})
    : [];
  let chooseTarget = (id: string | null) => {
    selectMachine(id);
    setError(null);
  };
  let targetItems: PopupMenuItem[] = [
    { type: "item", label: `Target: ${isLocal ? machine?.name ?? "This desktop" : machine?.name ?? "No machine available"}`, hint: "Default", disabled: true, onPress: () => {} },
    ...(hasLocal ? [{ type: "item" as const, label: "This desktop", active: isLocal, keepOpen: true, onPress: () => chooseTarget(localMachineId ?? null) }] : []),
    ...machines.machines.filter((item) => item.owned && item.id !== localMachineId).map((item) => ({
      type: "item" as const, label: item.name, active: target === item.id, hint: item.online ? undefined : "Offline",
      disabled: !item.online, keepOpen: true, onPress: () => chooseTarget(item.id),
    })),
    { type: "separator" },
    ...(!isLocal && !settings ? [{ type: "item" as const, label: machine?.online ? "Loading machine models…" : "Choose an online machine", disabled: true, onPress: () => {} }] : []),
  ];

  const launch = useCallback(async (nextProvider: ProcessProvider, modelId: string | null, nextEffort: AgentEffort | null) => {
    if (sendingRef.current) return;
    if (!isLocal && (!machine?.online || !machine.owned || !settings)) {
      setError("Choose an online machine and wait for its settings.");
      return;
    }
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    selectMachine(target ?? null);
    try {
      await onRunAgent("", nextProvider, modelId, nextEffort);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start agent");
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }, [onRunAgent, target, isLocal, machine?.online, settings]);

  return (
    <View
      style={styles.row}
      {...(Platform.OS === "web" && workDir ? { dataSet: { agentWorkdir: workDir } } : {})}
    >
      <AgentSelector
        mode="plus"
        disabled={busy}
        provider={provider}
        model={model}
        effort={effort}
        modelOptions={options}
        targetItems={targetItems}
        includeShell
        onChange={(selection) => launch(selection.provider, selection.modelId, selection.effort)}
        nativeBottomInset={88}
      />
      {busy && <Text style={styles.status}>Starting agent…</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  status: { color: colors.textSecondary, marginLeft: spacing.sm },
  error: { color: colors.danger, flexShrink: 1, marginLeft: spacing.sm },
  row: {
    flexDirection: "row",
    paddingHorizontal: Platform.OS === "web" ? spacing.xs : spacing.md,
    paddingVertical: Platform.OS === "web" ? 2 : spacing.sm,
  },
});
