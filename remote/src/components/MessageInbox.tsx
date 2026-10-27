import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { machineHostRequest, machineRequest, messagePending, useMachines, type MessageRecord } from "@clawtab/shared";
import { useMessageStore } from "../store/messages";
import { useNotificationStore } from "../store/notifications";
import { messageAction } from "../lib/messageActions";
import { messageSurfaceController } from "../lib/messageSurfaceController";
import { surfaceId, surfaceRecord } from "../lib/messagePresentation";
import { notificationJobRoute, notificationProcessRoute } from "../lib/notificationRoutes";
import type { NotificationDetailTarget } from "./notificationTypes";
import { MessageSurface } from "./MessageSurface";
import type { SurfaceMessage } from "./messageSurfaceTypes";
import { nextId } from "../lib/wsRuntime";

export function MessageInbox({ selection, onSelectDetail, onNavigateAway, onNative }: {
  selection?: string | null;
  onSelectDetail?: (target: NotificationDetailTarget) => void;
  onNavigateAway?: () => void;
  onNative?: (message: SurfaceMessage) => void;
}) {
  const router = useRouter();
  const records = useMessageStore(state => state.records);
  const autoYes = useNotificationStore(state => state.autoYesPaneIds);
  const { machines } = useMachines();
  const [templates, setTemplates] = useState<Record<string, unknown>>({});
  const latest = useRef({ records, machines, onSelectDetail, onNavigateAway });
  latest.current = { records, machines, onSelectDetail, onNavigateAway };
  const navigate = useCallback((record: MessageRecord) => {
    const source = record.request.source;
    const target: NotificationDetailTarget | null = source.pane_id ? { kind: "process", paneId: source.pane_id }
      : source.job_id ? { kind: "job", jobName: source.job_id } : null;
    if (!target) throw new Error("This message has no agent or job");
    if (latest.current.onSelectDetail) latest.current.onSelectDetail(target);
    else {
      latest.current.onNavigateAway?.();
      router.push(target.kind === "process" ? notificationProcessRoute(target.paneId) : notificationJobRoute(target.jobName));
    }
  }, [router]);
  const controller = useMemo(() => messageSurfaceController({
    records: () => useMessageStore.getState().records,
    machines: () => latest.current.machines,
    host: async (machine, command) => {
      const record = useMessageStore.getState().records.find(record => record.machine_id === machine && record.id === command.id);
      const pane = record?.request.source.pane_id;
      if (pane && command.op === "auto_yes") {
        const store = useNotificationStore.getState();
        const enabled = !store.autoYesPaneIds.has(pane);
        store.beginAutoYes(pane, enabled);
        try {
          const panes = [...useNotificationStore.getState().autoYesPaneIds]
            .filter(pane => pane.startsWith(`${machine}::`)).map(pane => pane.slice(machine.length + 2));
          await machineRequest(machine, { type: "set_auto_yes_panes", id: nextId(), pane_ids: panes });
          store.finishAutoYes(pane, true);
          return { auto_yes: enabled };
        } catch (error) { store.finishAutoYes(pane, false); throw error; }
      }
      if (pane && (command.op === "model" || command.op === "plugin")) {
        const result = await machineRequest(machine, { type: "start_agent_action", id: nextId(),
          pane_id: pane.startsWith(`${machine}::`) ? pane.slice(machine.length + 2) : pane,
          action_id: command.op === "model" ? "codex.set_model" : command.action_id,
          parameters: command.op === "model" ? { model: command.model, effort: command.effort } : command.parameters,
        });
        if (result.error) throw new Error(result.error);
        return result;
      }
      return machineHostRequest(machine, { action: "message", command });
    },
    update: record => useMessageStore.getState().updateRecord(record),
    navigate,
    act: messageAction,
  }), [navigate]);
  const machineKey = machines.filter(machine => machine.online).map(machine => machine.id).sort().join(",");
  useEffect(() => {
    let active = true;
    for (const machine of latest.current.machines.filter(machine => machine.online)) {
      void machineHostRequest(machine.id, { action: "message", command: { op: "templates" } })
        .then(value => { if (active) setTemplates(previous => ({ ...previous, [machine.id]: value })); })
        .catch(() => {});
    }
    return () => { active = false; };
  }, [machineKey]);
  const snapshot = useMemo(() => ({
    type: "snapshot", remote: true, visible: true, preview: false,
    records: records.map(surfaceRecord), pending_count: records.filter(messagePending).length,
    auto_yes_panes: [...autoYes], templates_by_machine: templates,
    settings: { preview_seconds: 8, hover_expand: false, placement: "right" },
  }), [records, autoYes, templates]);

  const selectionReady = !selection || records.some(record => surfaceId(record) === selection)
    || machines.some(machine => machine.online && selection.startsWith(`${machine.id}::`));
  return <View style={{ flex: 1, minHeight: 0 }}>
    {!selectionReady && <Text accessibilityLiveRegion="polite" style={{ color: "#98989d", padding: 12, fontSize: 13 }}>
      Waiting for this message's machine to connect...
    </Text>}
    <MessageSurface snapshot={snapshot} selection={selectionReady ? selection : null} onCommand={controller.execute} onNative={onNative} />
  </View>;
}
