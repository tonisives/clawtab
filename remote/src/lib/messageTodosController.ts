import { resourceKey } from "@clawtab/shared";

type Machine = { id: string; online: boolean };
type Command = Record<string, unknown>;
type Snapshot = Record<string, any>;
type Options = {
  machine: () => Machine | undefined;
  host: (machine: string, command: Command) => Promise<Snapshot>;
  update: (snapshot: Snapshot) => void;
  openAgent: (pane: string) => void;
};

export const isMessageTodoCommand = (command: Command) =>
  ["todos", "todo_add", "todo_update", "todo_start", "todo_focus"].includes(String(command.op));

export function messageTodosController(options: Options) {
  return async (command: Command) => {
    if (!isMessageTodoCommand(command)) throw new Error("Unsupported task operation");
    const machine = options.machine();
    if (!machine?.online) throw new Error("Connect to the task's machine first");
    const value = await options.host(machine.id, command.op === "todo_focus" ? { op: "todos" } : command);
    if (options.machine()?.id === machine.id) options.update(value);
    if (command.op === "todo_focus") {
      const task = value.items?.find((item: { id: string }) => item.id === command.id);
      if (!task?.agent?.pane) throw new Error("This task has no linked agent");
      options.openAgent(resourceKey(machine.id, task.agent.pane));
    }
    return value;
  };
}
