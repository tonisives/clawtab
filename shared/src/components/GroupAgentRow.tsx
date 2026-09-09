import { useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { spacing } from "../theme/spacing";
import type { AgentEffort, AgentModelOption, ProcessProvider } from "../types/process";
import { useMachines, selectMachine } from "../machines/client";
import { buildModelOptions } from "../util/agentModels";
import { MachineTargetPicker } from "../machines/TargetPicker";
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
  targetMachineId,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null, effort?: AgentEffort | null) => void | Promise<void>;
  provider?: ProcessProvider | null;
  model?: string | null;
  effort?: AgentEffort | null;
  modelOptions?: AgentModelOption[];
  workDir?: string;
  localMachineId?: string | null;
  targetMachineId?: string;
}) {
  const sendingRef = useRef(false);
  let machines = useMachines();
  let [busy, setBusy] = useState(false);
  let [error, setError] = useState<string | null>(null);
  let hasLocal = localMachineId !== undefined;
  let target = targetMachineId ?? machines.selected ?? localMachineId ?? (hasLocal ? null : machines.machines.find((machine) => machine.online && machine.owned)?.id);
  let isLocal = hasLocal && (target == null || target === localMachineId);
  let machine = machines.machines.find((machine) => machine.id === target);
  let settings = target ? machines.snapshots[target]?.settings_response : undefined;
  let options = machines.agentModels
    ? buildModelOptions(["claude", "codex", "opencode", "antigravity"], machines.agentModels.enabled_models)
    : modelOptions.length ? modelOptions : settings
      ? buildModelOptions(["claude", "codex", "opencode", "antigravity"], settings.enabled_models ?? {})
      : [];
  let chooseTarget = (id: string | null) => {
    selectMachine(id);
    setError(null);
  };

  const launch = useCallback(async (nextProvider: ProcessProvider, modelId: string | null, nextEffort: AgentEffort | null) => {
    if (sendingRef.current) return;
    if (!isLocal && (!machine?.online || !machine.owned)) {
      setError("Choose an online machine.");
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
  }, [onRunAgent, target, isLocal, machine?.online, machine?.owned, settings]);

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
        machinePicker={targetMachineId
          ? <Text style={styles.status}>{machine?.name ?? (isLocal ? "This desktop" : "Group machine")}{!isLocal && !machine?.online ? " · Offline" : ""}</Text>
          : <MachineTargetPicker target={target ?? null} localMachineId={localMachineId} onSelect={chooseTarget} />}
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
