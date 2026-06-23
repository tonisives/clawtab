import { View } from "react-native";

import { spacing } from "../../theme/spacing";
import { GroupAgentRow } from "../GroupAgentRow";
import type { JobListViewHook } from "./useJobListView";

interface JobListGroupAgentItemProps {
  hook: JobListViewHook;
  workDir: string;
  itemKey: string;
}

export function JobListGroupAgentItem({ hook, workDir, itemKey }: JobListGroupAgentItemProps) {
  return (
    <View key={itemKey} style={{ marginTop: spacing.sm }}>
      <GroupAgentRow
        provider={hook.groupAgent.resolveGroupAgentProvider(workDir)}
        providers={hook.groupAgent.resolvedAgentProviders}
        onProviderChange={(provider) => hook.groupAgent.handleSetGroupAgentProvider(workDir, provider)}
        model={hook.groupAgent.resolveGroupAgentModel(workDir)}
        modelOptions={hook.agentModelOptions}
        onModelChange={(provider, modelId) => hook.groupAgent.handleSetGroupAgentModel(workDir, provider, modelId)}
        onRunAgent={(prompt, provider, model) => hook.onRunAgent?.(prompt, workDir, provider, model)}
        focusSignal={hook.focusAgentWorkDir === workDir ? hook.focusAgentSignal : undefined}
        workDir={workDir}
      />
    </View>
  );
}
