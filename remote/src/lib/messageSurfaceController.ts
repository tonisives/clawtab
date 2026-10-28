import { messagePending, resourceKey, type MessageRecord } from "@clawtab/shared";
import { parseSurfaceId, surfaceId, surfaceRecord } from "./messagePresentation";

type Command = Record<string, unknown>;
type Result = Record<string, any>;
type Options = {
  records: () => MessageRecord[];
  machines: () => { id: string; online: boolean }[];
  host: (machine: string, command: Command) => Promise<Result>;
  update: (record: MessageRecord) => void;
  navigate: (record: MessageRecord) => void;
  act: (action: { machine: string; id: string; op: "respond" | "dismiss"; action_id?: string; text?: string }) => Promise<void>;
};

export function messageSurfaceController(options: Options) {
  const cache = new Map<string, MessageRecord>();
  const remember = (machine: string, raw: Result) => {
    const source = raw.request.source;
    const scope = (id?: string) => id && (id.startsWith(`${machine}::`) ? id : resourceKey(machine, id));
    const record = { ...raw, machine_id: machine, request: { ...raw.request, source: {
      ...source, pane_id: scope(source.pane_id), job_id: scope(source.job_id),
    } } } as MessageRecord;
    cache.set(surfaceId(record), record);
    return record;
  };
  const all = () => {
    const records = new Map(cache);
    for (const record of options.records()) records.set(surfaceId(record), record);
    return [...records.values()];
  };
  const get = async (key: string) => {
    const target = parseSurfaceId(key);
    const existing = all().find(record => surfaceId(record) === key);
    if (existing) return existing;
    return remember(target.machine, await options.host(target.machine, { op: "get", id: target.id }));
  };
  const scopedAgents = (machine: string, agents: Result[]) => agents.map(agent => ({ ...agent, machine_id: machine, id: resourceKey(machine, agent.id) }));

  return {
    async execute(command: Command): Promise<Result> {
      const op = String(command.op);
      if (op === "ignored_agents") {
        const agents = await Promise.all(options.machines().filter(machine => machine.online).map(async machine => {
          const result = await options.host(machine.id, { op });
          return scopedAgents(machine.id, result.agents || []);
        }));
        return { agents: agents.flat() };
      }
      if ((op === "ignore" || op === "unignore") && typeof command.id === "string") {
        const { machine, id } = parseSurfaceId(command.id);
        const result = await options.host(machine, { op, id });
        const records = (result.records || []).map((raw: Result) => remember(machine, raw));
        for (const record of records) options.update(record);
        return { records: records.map(surfaceRecord) };
      }
      if (op === "templates" && typeof command.machine === "string") {
        return options.host(command.machine, { op: "templates" });
      }
      if (op === "list") {
        const offset = Number(command.offset) || 0;
        const online = options.machines().filter(machine => machine.online);
        const onlineIds = new Set(online.map(machine => machine.id));
        const listed = new Map<string, MessageRecord>();
        // Each machine owns its pagination. Fetch through the global offset before merging pages.
        await Promise.all(online.map(async machine => {
          for (let page = 0; page <= offset; page += 50) {
            const result = await options.host(machine.id, { ...command, offset: page });
            for (const raw of result.records || []) {
              const record = remember(machine.id, raw);
              listed.set(surfaceId(record), record);
            }
            if ((result.records?.length || 0) < 50) break;
          }
        }));
        const records = [...listed.values(), ...all().filter(record => !onlineIds.has(record.machine_id))]
          .filter(record => !command.pending_only || messagePending(record))
          .sort((a, b) => b.created_at - a.created_at || surfaceId(a).localeCompare(surfaceId(b)));
        return { records: records.slice(offset, offset + 50).map(surfaceRecord), next_offset: offset + 50 };
      }
      if (op === "dismiss_many") {
        const records = await Promise.all((command.ids as string[]).map(async key => {
          const { machine, id } = parseSurfaceId(key);
          await options.act({ machine, id, op: "dismiss" });
          return surfaceRecord(await get(key));
        }));
        return { records };
      }
      if (typeof command.id !== "string") throw new Error("Choose a message first");
      const { machine, id } = parseSurfaceId(command.id);
      if (op === "get" && options.machines().some(host => host.id === machine && host.online)) {
        const record = remember(machine, await options.host(machine, { op, id }));
        options.update(record);
        return surfaceRecord(record);
      }
      const record = await get(command.id);
      if (op === "get") return surfaceRecord(record);
      if (op === "focus" || op === "open_job") {
        options.navigate(record);
        return { focused: true, record: surfaceRecord(record) };
      }
      if (op === "respond" || op === "dismiss") {
        if (op === "respond" && record.request.actions.find(action => action.id === command.action_id)?.kind === "focus") {
          options.navigate(record);
          return { focused: true, record: surfaceRecord(record) };
        }
        await options.act({ machine, id, op, ...(typeof command.action_id === "string" ? { action_id: command.action_id } : {}),
          ...(typeof command.text === "string" ? { text: command.text } : {}) });
        const next = await get(command.id);
        if (messagePending(next)) throw new Error("Saved. Waiting for the machine to reconnect.");
        return surfaceRecord(next);
      }
      const value = await options.host(machine, { ...command, id });
      if (value.request && value.id) {
        const record = remember(machine, value);
        options.update(record);
        return surfaceRecord(record);
      }
      if (op === "context") return { ...value, source: { ...value.source, ...record.request.source,
        ...(value.source?.model ? { model: value.source.model } : {}),
      } };
      return value;
    },
  };
}
