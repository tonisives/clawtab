import { AddMachineButton } from "../machines/Onboarding";
import { useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { spacing } from "../theme/spacing";
import type { AgentEffort, AgentModelOption, ProcessProvider } from "../types/process";
import { useMachines, selectMachine, machineHostRequest, machineRequest, type MachineMessage } from "../machines/client";
import { defaultAgentFolder, resolveAgentFolder } from "../util/agentFolder";
import { buildModelOptions, hostModelCatalog } from "../util/agentModels";
import { MachineTargetPicker } from "../machines/TargetPicker";
import { colors } from "../theme/colors";
import { AgentSelector } from "./AgentSelector";
import { ModelManager } from "../machines/Models";

export function GroupAgentRow({
  onRunAgent,
  modelOptions = [],
  provider,
  model,
  effort,
  workDir,
  localMachineId,
  targetMachineId,
  sourceMachineId,
  localHostRequest,
  mode = "plus",
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null, effort?: AgentEffort | null, workDir?: string, requestedFolder?: string) => void | Promise<void>;
  provider?: ProcessProvider | null;
  model?: string | null;
  effort?: AgentEffort | null;
  modelOptions?: AgentModelOption[];
  workDir?: string;
  localMachineId?: string | null;
  targetMachineId?: string;
  sourceMachineId?: string;
  localHostRequest?: (request: MachineMessage) => Promise<MachineMessage>;
  mode?: "plus" | "start";
}) {
  const sendingRef = useRef(false);
  let machines = useMachines();
  let [busy, setBusy] = useState(false);
  let [error, setError] = useState<string | null>(null);
  let hasLocal = localMachineId !== undefined;
  let target = targetMachineId ?? machines.selected ?? localMachineId ?? (hasLocal ? null : machines.machines.find((machine) => machine.online && machine.owned)?.id);
  let isLocal = hasLocal && (target == null || target === localMachineId);
  let machine = machines.machines.find((machine) => machine.id === target);
  let folder = defaultAgentFolder(workDir, sourceMachineId ?? localMachineId, target);
  let settings = target ? machines.snapshots[target]?.settings_response : undefined;
  let detected = hasLocal ? settings?.detected_models : hostModelCatalog(settings);
  let settingsOptions = settings
    ? buildModelOptions(["claude", "codex", "opencode", "antigravity"], settings.enabled_models ?? {}, detected, settings.disabled_models)
    : [];
  let options = machines.agentModels
    ? buildModelOptions(["claude", "codex", "opencode", "antigravity"], machines.agentModels.enabled_models, detected, machines.agentModels.disabled_models)
    : !hasLocal && settings ? settingsOptions : modelOptions.length ? modelOptions : settingsOptions;
  let refreshModels = () => {
    if (!hasLocal && target && machine?.owned && machine.online) {
      void machineRequest(target, { type: "get_settings" }).catch(() => {});
    }
  };
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
      let request = isLocal ? localHostRequest : target ? (request: MachineMessage) => machineHostRequest(target, request) : undefined;
      if (!request) throw new Error("Could not check the folder on this machine.");
      let resolvedFolder = await resolveAgentFolder(folder, request);
      selectMachine(target ?? null);
      await onRunAgent("", nextProvider, modelId, nextEffort, resolvedFolder, folder);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not start agent");
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }, [onRunAgent, target, isLocal, machine?.online, machine?.owned, localHostRequest, folder]);

  return (
    <View
      style={[styles.row, mode === "start" && styles.startRow]}
      {...(Platform.OS === "web" && workDir ? { dataSet: { agentWorkdir: workDir } } : {})}
    >
      <AgentSelector
        mode={mode}
        label={mode === "start" ? "+ Add agent" : undefined}
        fullWidth={mode === "start"}
        disabled={busy}
        provider={provider}
        model={model}
        effort={effort}
        modelOptions={options}
        modelEditor={!hasLocal ? <ModelManager machineId={target ?? undefined} compact /> : undefined}
        onOpen={refreshModels}
        machinePicker={<View>
          {targetMachineId
          ? <View><Text style={styles.status}>{machine?.name ?? (isLocal ? "This desktop" : "Group machine")}{!isLocal && !machine?.online ? " · Offline" : ""}</Text><AddMachineButton /></View>
          : <MachineTargetPicker target={target ?? null} localMachineId={localMachineId} onSelect={chooseTarget} />}
        </View>}
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
  startRow: { width: "100%", paddingHorizontal: 0, paddingVertical: 0 },
});
