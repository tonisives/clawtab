import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DetectedProcess } from "../types/process";
import { agentAlertProcesses, agentAlertTitle } from "../util/alert";
import { processDisplayTitle, shortenPath } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function AgentAlertCards({ processes, onOpen }: {
  processes: DetectedProcess[];
  onOpen: (process: DetectedProcess) => void;
}) {
  return <>
    {agentAlertProcesses(processes).map((process) => (
      <View key={process.pane_id} style={styles.card}>
        <View style={styles.heading}>
          <Text style={styles.marker} accessibilityLabel="Agent alert">!</Text>
          <Text style={styles.title} numberOfLines={2}>{processDisplayTitle(process)}</Text>
          <Text style={styles.label}>{agentAlertTitle(process._agent_alert)}</Text>
        </View>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{shortenPath(process.cwd)}</Text>
        <Text style={styles.body} selectable>{process._agent_alert}</Text>
        <Pressable
          onPress={() => onOpen(process)}
          accessibilityRole="button"
          accessibilityLabel={`Open session: ${processDisplayTitle(process)}`}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Open session</Text>
        </Pressable>
      </View>
    ))}
  </>;
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    gap: spacing.sm,
  },
  heading: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  marker: { color: "#ff8700", fontSize: 20, fontWeight: "800" },
  title: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  label: { color: "#ff8700", fontSize: 11 },
  path: { color: colors.textSecondary, fontSize: 11 },
  body: { color: colors.text, fontSize: 13, lineHeight: 20 },
  button: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
  },
  buttonText: { color: colors.text, fontSize: 12, fontWeight: "600" },
});
