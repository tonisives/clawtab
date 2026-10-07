import { createContext, useContext, useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { MachineActionButton, MachineModal, MachineSettingsPageButton } from "../machines/Onboarding";
import { MachineTerminalControls } from "../machines/Terminal";
import { resourceLabel } from "../machines/client";
import { colors } from "../theme/colors";
import { compactPath, formatTime, timeAgo } from "../util/format";
import type { AgentActionDescriptor } from "../types/agentPlugin";
import type { PaneOverviewActions, PaneOverviewData } from "./PaneOverviewModal";
import { AgentActionFormModal } from "./AgentActionFormModal";
import { InsetList, InsetListRow } from "./InsetList";

type DetailsContext = {
  pane: PaneOverviewData;
  actions?: PaneOverviewActions;
  actionRunActive: boolean;
  runAction: (action: AgentActionDescriptor) => void;
};
let DetailsContext = createContext<DetailsContext | null>(null);
let useDetails = () => {
  let context = useContext(DetailsContext);
  if (!context) throw new Error("Agent details context is missing");
  return context;
};

let PaneToggle = ({ label, value, onChange }: { label: string; value?: boolean; onChange: () => void }) => (
  <InsetListRow title={label} accessory={<Switch value={!!value} onValueChange={onChange} trackColor={{ false: colors.borderLight, true: colors.accent }} thumbColor={colors.surface} ios_backgroundColor={colors.borderLight} accessibilityLabel={label} />} />
);

let QueryCard = ({ title, query }: { title: string; query?: string | null }) => {
  if (!query?.trim()) return null;
  let value = query.trim();
  if (value.length > 640) value = `${value.slice(0, 316).trimEnd()}\n...\n${value.slice(-316).trimStart()}`;
  return <View style={styles.queryCard}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <Text style={styles.query} selectable>{value}</Text>
  </View>;
};

let AgentActionsPage = () => {
  let { actions, actionRunActive, runAction } = useDetails();
  let run = actions?.agentActionRun;
  return <View style={styles.page}>
    {run && <InsetList>
      <InsetListRow title={run.progress || "Agent action"} description={run.error ?? `${run.progressPercent}% · ${run.state}`} accessory={actionRunActive && actions?.onCancelAgentAction ? <MachineActionButton label="Cancel" onPress={actions.onCancelAgentAction} /> : undefined} />
    </InsetList>}
    <InsetList>
      {actions?.agentActions?.map((action) => {
        let disabled = !action.available || actionRunActive || !actions.onRunAgentAction;
        let press = () => runAction(action);
        let description = [action.plugin_name, action.unavailable_reason ?? action.description].filter(Boolean).join(" · ");
        return <InsetListRow key={action.id} title={action.title} description={description} accessory={<MachineActionButton label={!action.available ? "Unavailable" : action.parameters.length ? "Configure" : "Run"} accessibilityLabel={`${action.parameters.length ? "Configure" : "Run"} ${action.title}`} disabled={disabled} onPress={press} />} />;
      })}
    </InsetList>
  </View>;
};

let PaneDetailsPage = () => {
  let { pane, actions } = useDetails();
  let latestQuery = pane.lastQuery !== pane.firstQuery ? pane.lastQuery : null;
  let started = pane.startedAt ? `${formatTime(pane.startedAt)} (${timeAgo(pane.startedAt)})` : "-";
  return <View style={styles.page}>
    <MachineTerminalControls paneId={pane.paneId} connectedOnly inset />
    {(actions?.onToggleAutoYes || actions?.onTogglePin) && <InsetList>
      {actions.onToggleAutoYes && <PaneToggle label="Auto Yes" value={actions.autoYesActive} onChange={actions.onToggleAutoYes} />}
      {actions.onTogglePin && <PaneToggle label="Pin pane" value={actions.isPinned} onChange={actions.onTogglePin} />}
    </InsetList>}
    {actions?.onStop ? <MachineActionButton label={actions.stopping ? "Stopping…" : "Stop session"} tone="danger" disabled={actions.stopping} onPress={actions.onStop} style={styles.sessionButton} /> : actions?.onStart ? <MachineActionButton label={actions.starting ? "Starting…" : "Start process"} disabled={actions.starting} onPress={actions.onStart} style={styles.sessionButton} /> : null}
    {!!actions?.agentActions?.length && <View style={styles.actionsLink}>
      <MachineSettingsPageButton title="Agent actions"><AgentActionsPage /></MachineSettingsPageButton>
      {actions.agentActionRun && <Text style={styles.hint}>{actions.agentActionRun.error ?? actions.agentActionRun.progress}</Text>}
    </View>}
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{pane.cwd ? compactPath(pane.cwd) : "Session"}</Text>
      <InsetList>
        {!!pane.cwd && <InsetListRow title="Folder" description={pane.cwd} selectable />}
        <InsetListRow title="Started" description={started} selectable />
        <InsetListRow title="Session" description={pane.tmuxSession || "-"} selectable />
        <InsetListRow title="Window" description={pane.windowName || "-"} selectable />
        <InsetListRow title="Pane" description={resourceLabel(pane.paneId)} selectable />
      </InsetList>
    </View>
    <QueryCard title="First query" query={pane.firstQuery} />
    <QueryCard title="Latest query" query={latestQuery} />
  </View>;
};

export let NativePaneOverview = ({ visible, onClose, actions, ...pane }: PaneOverviewData & { visible: boolean; onClose: () => void; actions?: PaneOverviewActions }) => {
  let [selectedAction, setSelectedAction] = useState<AgentActionDescriptor | null>(null);
  let actionRunActive = !!actions?.agentActionRun && ["queued", "running"].includes(actions.agentActionRun.state);
  useEffect(() => { if (!visible) setSelectedAction(null); }, [visible]);
  let close = () => { setSelectedAction(null); onClose(); };
  let closeForm = () => setSelectedAction(null);
  let runAction = (action: AgentActionDescriptor) => {
    if (!action.available || actionRunActive || !actions?.onRunAgentAction) return;
    if (action.parameters.length) { setSelectedAction(action); return; }
    actions.onRunAgentAction(action.id);
  };
  let submit = (parameters: Record<string, string>) => {
    if (!selectedAction || actionRunActive) return;
    actions?.onRunAgentAction?.(selectedAction.id, parameters);
    setSelectedAction(null);
  };
  if (!visible) return null;
  return <DetailsContext.Provider value={{ pane, actions, actionRunActive, runAction }}>
    <MachineModal title="Agent details" onClose={close} overlay={<AgentActionFormModal action={selectedAction} visible={!!selectedAction} onClose={closeForm} onSubmit={submit} submitting={actionRunActive} />}>
      <PaneDetailsPage />
    </MachineModal>
  </DetailsContext.Provider>;
};

let styles = StyleSheet.create({
  page: { padding: 16, gap: 24 },
  section: { gap: 8 },
  sectionTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", marginHorizontal: 18 },
  actionsLink: { gap: 8 },
  hint: { color: colors.textSecondary, fontSize: 13, marginHorizontal: 18 },
  queryCard: { paddingVertical: 16, gap: 12, backgroundColor: colors.surface, borderRadius: 24, borderCurve: "continuous" },
  query: { color: colors.text, fontSize: 13, lineHeight: 20, paddingHorizontal: 18, fontFamily: "monospace" },
  sessionButton: { alignSelf: "flex-start" },
});
