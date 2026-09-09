import {
  machineJobs,
  machineProcesses,
  machineHostRequest,
  machineSend,
  onMachineEvent,
  machineRequest,
  machineState,
  scopedMessage,
  splitResource,
  type Transport,
} from "@clawtab/shared"
import { localMachineId } from "./connection"
export let withMachines = (local: Transport): Transport => {
  let remote = async (key: string, type: string, extra: Record<string, unknown> = {}) => {
    let resource = splitResource(key)
    if (!resource) throw new Error("Machine identity missing")
    return scopedMessage(
      resource.machine,
      await machineRequest(resource.machine, { type, name: resource.id, ...extra }),
    )
  }
  return {
    ...local,
    cacheJobs: local.cacheJobs
      ? async (jobs, statuses) =>
          local.cacheJobs!(
            jobs.filter((job) => !job.machine_id),
            Object.fromEntries(Object.entries(statuses).filter(([key]) => !splitResource(key))),
          )
      : undefined,
    listJobs: async () => {
      let own = await local.listJobs()
      let others = machineJobs(localMachineId())
      if (machineState().filter && machineState().filter !== localMachineId()) return others
      return {
        jobs: [...own.jobs, ...others.jobs],
        statuses: { ...own.statuses, ...others.statuses },
      }
    },
    getStatuses: async () => ({
      ...(await local.getStatuses()),
      ...machineJobs(localMachineId()).statuses,
    }),
    detectProcesses: async () => {
      let own = await local.detectProcesses()
      let others = machineProcesses(localMachineId())
      return machineState().filter && machineState().filter !== localMachineId()
        ? others
        : [...own, ...others]
    },
    runJob: async (name, params) =>
      splitResource(name)
        ? ((await remote(name, "run_job", { params: params ?? {} })) as any)
        : local.runJob(name, params),
    stopJob: async (name) => {
      if (splitResource(name)) await remote(name, "stop_job")
      else await local.stopJob(name)
    },
    pauseJob: async (name) => {
      if (splitResource(name)) await remote(name, "pause_job")
      else await local.pauseJob(name)
    },
    resumeJob: async (name) => {
      if (splitResource(name)) await remote(name, "resume_job")
      else await local.resumeJob(name)
    },
    toggleJob: async (name) => {
      if (!splitResource(name)) return local.toggleJob(name)
      let job = machineJobs().jobs.find((j) => j.slug === name || j.name === name)
      await remote(name, "update_job", { update: { enabled: !job?.enabled } })
    },
    deleteJob: async (name) => {
      let resource = splitResource(name)
      if (resource)
        await machineHostRequest(resource.machine, { action: "delete_job", name: resource.id })
      else await local.deleteJob(name)
    },
    updateJob: async (name, update) => {
      if (splitResource(name)) await remote(name, "update_job", { update })
      else if (local.updateJob) await local.updateJob(name, update)
    },
    getRunHistory: async (name) =>
      splitResource(name)
        ? (await remote(name, "get_run_history", { limit: 50 })).runs
        : local.getRunHistory(name),
    getRunDetail: async (id) => {
      let resource = splitResource(id)
      if (!resource) return local.getRunDetail(id)
      return (
        (await machineRequest(resource.machine, { type: "get_run_detail", run_id: resource.id }))
          .detail ?? null
      )
    },
    sendInput: async (name, text, freetext) => {
      if (splitResource(name)) await remote(name, "send_input", { text, freetext })
      else await local.sendInput(name, text, freetext)
    },
    subscribeLogs: (name, onChunk) => {
      let resource = splitResource(name)
      if (!resource) return local.subscribeLogs(name, onChunk)
      let unlisten = onMachineEvent((machine, message) => {
        if (
          machine === resource.machine &&
          message.type === "log_chunk" &&
          message.name === resource.id
        )
          onChunk(message.content)
      })
      machineSend(resource.machine, { type: "subscribe_logs", name: resource.id })
      return () => {
        unlisten()
        machineSend(resource.machine, { type: "unsubscribe_logs", name: resource.id })
      }
    },
    runAgent: async (prompt, workDir, provider, model, effort) => {
      let machine = machineState().selected
      if (!machine || machine === localMachineId())
        return local.runAgent(prompt, workDir, provider, model, effort)
      let response = scopedMessage(
        machine,
        await machineRequest(machine, {
          type: "run_agent",
          prompt,
          work_dir: workDir,
          provider,
          model,
          effort,
        }),
      )
      if (response.success === false || response.error) throw new Error(response.error ?? response.message ?? "Could not start agent")
      return response.pane_id
        ? { pane_id: response.pane_id, tmux_session: response.tmux_session }
        : null
    },
  }
}
