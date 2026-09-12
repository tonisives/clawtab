import { useMachines } from "../../machines/client";
import { Text, View } from "react-native";

import { spacing } from "../../theme/spacing";
import { GroupAgentRow } from "../GroupAgentRow";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListGroupAgentItemProps {
  hook: JobListViewHook;
  workDir: string;
  footerPath?: string;
  machineId?: string;
  sourceMachineId?: string;
  itemKey: string;
}

export function JobListGroupAgentItem({ hook, workDir, footerPath, machineId, sourceMachineId, itemKey }: JobListGroupAgentItemProps) {
  let machines = useMachines();
  let machineName = machines.machines.find((machine) => machine.id === machineId)?.name;
  return (
    <View key={itemKey} style={[styles.groupAgentFooterRow, { marginTop: spacing.sm }]}>
      <GroupAgentRow
        localMachineId={hook.localAgentMachineId}
        targetMachineId={machineId}
        sourceMachineId={sourceMachineId ?? machineId}
        localHostRequest={hook.localHostRequest}
        provider={hook.groupAgent.resolveGroupAgentProvider(workDir)}
        model={hook.groupAgent.resolveGroupAgentModel(workDir)}
        effort={hook.groupAgent.resolveGroupAgentEffort(workDir)}
        modelOptions={hook.agentModelOptions}
        onRunAgent={(prompt, provider, model, effort, resolvedWorkDir) => {
          if (provider) hook.groupAgent.handleSetGroupAgentModel(workDir, provider, model ?? null, effort ?? null);
          return hook.onRunAgent?.(prompt, resolvedWorkDir ?? workDir, provider, model, effort);
        }}
        workDir={workDir}
      />
      {footerPath ? (
        <Text style={[styles.groupFolderPath, styles.groupAgentFooterPath]} numberOfLines={1}>
          {machineName ? `${machineName} · ` : ""}{footerPath.replace(/^\/Users\/[^/]+/, "~")}
        </Text>
      ) : null}
    </View>
  );
}
