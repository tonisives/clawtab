import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { machineHostRequest, machineRequest, messagePending, useMachines, type MessageRecord } from "@clawtab/shared";
import { useMessageStore } from "../store/messages";
import { useNotificationStore } from "../store/notifications";
import { messageAction } from "../lib/messageActions";
import { messageSurfaceController } from "../lib/messageSurfaceController";
import { isMessageTodoCommand, messageTodosController } from "../lib/messageTodosController";
import { surfaceId, surfaceRecord } from "../lib/messagePresentation";
import { notificationJobRoute, notificationProcessRoute } from "../lib/notificationRoutes";
import type { NotificationDetailTarget } from "./notificationTypes";
import { MessageSurface } from "./MessageSurface";
import type { SurfaceMessage } from "./messageSurfaceTypes";
import { nextId } from "../lib/wsRuntime";

export function MessageInbox({ selection, popup = false, onSelectDetail, onNavigateAway, onNative }: {
  selection?: string | null;
  popup?: boolean;
  onSelectDetail?: (target: NotificationDetailTarget) => void;
  onNavigateAway?: () => void;
  onNative?: (message: SurfaceMessage) => void;
}) {
  const router = useRouter();
  const records = useMessageStore(state => state.records);
  const autoYes = useNotificationStore(state => state.autoYesPaneIds);
  const { machines, selected } = useMachines();
  const [templates, setTemplates] = useState<Record<string, unknown>>({});
  const [todos, setTodos] = useState<Record<string, any>>({ items: [] });
  const latest = useRef({ records, machines, onSelectDetail, onNavigateAway });
  latest.current = { records, machines, onSelectDetail, onNavigateAway };
  const openDetail = useCallback((target: NotificationDetailTarget) => {
    if (latest.current.onSelectDetail) latest.current.onSelectDetail(target);
    else {
      latest.current.onNavigateAway?.();
      router.push(target.kind === "process" ? notificationProcessRoute(target.paneId) : notificationJobRoute(target.jobName));
    }
  }, [router]);
  const navigate = useCallback((record: MessageRecord) => {
    const source = record.request.source;
    const target: NotificationDetailTarget | null = source.pane_id ? { kind: "process", paneId: source.pane_id }
      : source.job_id ? { kind: "job", jobName: source.job_id } : null;
    if (!target) throw new Error("This message has no agent or job");
    openDetail(target);
  }, [openDetail]);
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
  const todoMachine = (selection ? machines.find(machine => selection.startsWith(`${machine.id}::`))
    : machines.find(machine => machine.id === selected))
    ?? machines.find(machine => machine.online && machine.owned);
  const todoMachineRef = useRef(todoMachine);
  todoMachineRef.current = todoMachine;
  const todoCommand = useMemo(() => messageTodosController({
    machine: () => todoMachineRef.current,
    host: (machine, command) => machineHostRequest(machine, { action: "message", command }),
    update: setTodos,
    openAgent: paneId => openDetail({ kind: "process", paneId }),
  }), [openDetail]);
  useEffect(() => {
    let active = true;
    let busy = false;
    setTodos({ items: [] });
    const refresh = async () => {
      if (busy || !todoMachine?.online) return;
      busy = true;
      try {
        const value = await machineHostRequest(todoMachine.id, { action: "message", command: { op: "todos" } });
        if (active) setTodos(value);
      } catch { /* The message inbox stays usable while its host reconnects. */ }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [todoMachine?.id, todoMachine?.online]);
  const command = useCallback(async (command: Record<string, unknown>) => {
    return isMessageTodoCommand(command) ? todoCommand(command) : controller.execute(command);
  }, [controller, todoCommand]);
  const snapshot = useMemo(() => ({
    type: "snapshot", remote: true, visible: true, preview: false,
    records: records.map(surfaceRecord), pending_count: records.filter(messagePending).length,
    auto_yes_panes: [...autoYes], templates_by_machine: templates, todos,
    settings: { preview_seconds: 8, hover_expand: false, placement: "right" },
  }), [records, autoYes, templates, todos]);

  const selectionReady = !selection || records.some(record => surfaceId(record) === selection)
    || machines.some(machine => machine.online && selection.startsWith(`${machine.id}::`));
  return <View style={{ flex: 1, minHeight: 0 }}>
    {!selectionReady && <Text accessibilityLiveRegion="polite" style={{ color: "#98989d", padding: 12, fontSize: 13 }}>
      Waiting for this message's machine to connect...
    </Text>}
    <MessageSurface snapshot={snapshot} selection={selectionReady ? selection : null} popup={popup} onCommand={command} onNative={onNative} />
  </View>;
}
