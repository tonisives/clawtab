import { messagePending, resourceKey, type MessageRecord, type SocialDecision } from "@clawtab/shared";
import { parseSurfaceId, surfaceId, surfaceRecord } from "./messagePresentation";

type Command = Record<string, unknown>;
type Result = Record<string, any>;
type Options = {
  records: () => MessageRecord[];
  machines: () => { id: string; online: boolean }[];
  host: (machine: string, command: Command) => Promise<Result>;
  update: (record: MessageRecord) => void;
  navigate: (record: MessageRecord) => void;
  act: (action: { machine: string; id: string; op: "respond" | "dismiss"; action_id?: string; text?: string; decisions?: SocialDecision[] }) => Promise<void>;
};

export function messageSurfaceController(options: Options) {
  const cache = new Map<string, MessageRecord>();
  const targetRequests = new Map<string, { at: number; request: Promise<Result> }>();
  const verifiedTargets = new Map<string, { at: number; value: Result }>();
  const sessionTargets = (machine: string, id: string) => {
    const key = `${machine}::${id}`, cached = targetRequests.get(key);
    if (cached && Date.now() - cached.at < 5000) return cached.request;
    const request = options.host(machine, { op: "session_targets", id }).then(value => {
      verifiedTargets.set(key, { at: Date.now(), value });
      return value;
    }).catch(error => { targetRequests.delete(key); verifiedTargets.delete(key); throw error; });
    targetRequests.set(key, { at: Date.now(), request });
    if (targetRequests.size > 50) {
      const oldest = targetRequests.keys().next().value!;
      targetRequests.delete(oldest); verifiedTargets.delete(oldest);
    }
    return request;
  };
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
  const scopedAgents = (machine: string, agents: Result[]) => agents.map(agent => ({ ...agent, machine_id: machine, id: resourceKey(machine, agent.id), source: {
    ...agent.source,
    pane_id: agent.source?.pane_id && resourceKey(machine, agent.source.pane_id),
    job_id: agent.source?.job_id && resourceKey(machine, agent.source.job_id),
  } }));

  return {
    async execute(command: Command): Promise<Result> {
      const op = String(command.op);
      if (op === "ignored_agents") {
        const agents = await Promise.all(options.machines().filter(machine => machine.online).map(async machine => {
          const result = await options.host(machine.id, { op });
          return { agents: scopedAgents(machine.id, result.agents || []), jobs: (result.jobs || []).map((job: string) => resourceKey(machine.id, job)) };
        }));
        return { agents: agents.flatMap(result => result.agents), jobs: agents.flatMap(result => result.jobs) };
      }
      if (op === "ignore_job_success" && typeof command.job_id === "string") {
        const { machine, id } = parseSurfaceId(command.job_id);
        const result = await options.host(machine, { op, job_id: id, ignored: command.ignored });
        const records = (result.records || []).map((raw: Result) => remember(machine, raw));
        for (const record of records) options.update(record);
        return { records: records.map(surfaceRecord) };
      }
      if ((op === "ignore" || op === "unignore") && typeof command.id === "string") {
        const { machine, id } = parseSurfaceId(command.id);
        const result = await options.host(machine, { op, id });
        const records = (result.records || []).map((raw: Result) => remember(machine, raw));
        for (const record of records) options.update(record);
        return { records: records.map(surfaceRecord), agents: scopedAgents(machine, result.agents || []) };
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
          .filter(record => String(command.query || "").toLowerCase().split(/\s+/).filter(Boolean).every(term => JSON.stringify(record.request).toLowerCase().includes(term)))
          .sort((a, b) => (command.pending_only ? 0 :
            Math.max(b.dismissed_at || 0, b.response?.responded_at || 0) - Math.max(a.dismissed_at || 0, a.response?.responded_at || 0))
            || b.created_at - a.created_at || surfaceId(a).localeCompare(surfaceId(b)));
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
      if (op === "session_targets") return sessionTargets(machine, id);
      const focusAction = op === "respond" && record.request.actions.find(action => action.id === command.action_id)?.kind === "focus";
      if (op === "focus" || focusAction) {
        let target = record;
        if (record.request.source.session_id) {
          const key = `${machine}::${id}`, verified = verifiedTargets.get(key);
          if (command.pane_id) targetRequests.delete(key);
          const value = !command.pane_id && verified && Date.now() - verified.at < 15000
            ? verified.value : await sessionTargets(machine, id);
          const targets: Result[] = value.targets || [];
          if (!command.pane_id && targets.length > 1) return { targets };
          const selected = command.pane_id ? targets.find(item => item.pane_id === command.pane_id) : targets[0];
          if (command.pane_id && !selected) throw new Error("This pane is no longer showing the message's conversation");
          if (selected) target = { ...record, request: { ...record.request, source: { ...record.request.source,
            pane_id: resourceKey(machine, selected.pane_id),
          } } };
          else if (record.request.deliver_at) {
            const resumed = await options.host(machine, { op: "resume", id });
            if (resumed.targets?.length > 1) return { targets: resumed.targets };
            if (resumed.record) target = remember(machine, resumed.record);
            else if (resumed.targets?.[0]) target = { ...record, request: { ...record.request, source: { ...record.request.source, pane_id: resourceKey(machine, resumed.targets[0].pane_id) } } };
          }
        }
        options.navigate(target);
        return { focused: true, record: surfaceRecord(record) };
      }
      if (op === "open_job") {
        options.navigate(record);
        return { focused: true, record: surfaceRecord(record) };
      }
      if (op === "respond" || op === "dismiss") {
        await options.act({ machine, id, op, ...(typeof command.action_id === "string" ? { action_id: command.action_id } : {}),
          ...(typeof command.text === "string" ? { text: command.text } : {}),
          ...(Array.isArray(command.decisions) ? { decisions: command.decisions as SocialDecision[] } : {}) });
        const next = await get(command.id);
        if (messagePending(next)) throw new Error("Saved. Waiting for the machine to reconnect.");
        return surfaceRecord(next);
      }
      if (op === "context" && record.request.source.session_id) void sessionTargets(machine, id).catch(() => {});
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
