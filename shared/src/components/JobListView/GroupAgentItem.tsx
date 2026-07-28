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
        model={hook.groupAgent.resolveGroupAgentModel(workDir)}
        effort={hook.groupAgent.resolveGroupAgentEffort(workDir)}
        modelOptions={hook.agentModelOptions}
        onRunAgent={(prompt, provider, model, effort) => {
          if (provider) hook.groupAgent.handleSetGroupAgentModel(workDir, provider, model ?? null, effort ?? null);
          return hook.onRunAgent?.(prompt, workDir, provider, model, effort);
        }}
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
