import { Text, View } from "react-native";

import { spacing } from "../../theme/spacing";
import { GroupAgentRow } from "../GroupAgentRow";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListGroupAgentItemProps {
  hook: JobListViewHook;
  workDir: string;
  footerPath?: string;
  itemKey: string;
}

export function JobListGroupAgentItem({ hook, workDir, footerPath, itemKey }: JobListGroupAgentItemProps) {
  return (
    <View key={itemKey} style={[styles.groupAgentFooterRow, { marginTop: spacing.sm }]}>
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
      {footerPath ? (
        <Text style={[styles.groupFolderPath, styles.groupAgentFooterPath]} numberOfLines={1}>
          {footerPath.replace(/^\/Users\/[^/]+/, "~")}
        </Text>
      ) : null}
    </View>
  );
}
