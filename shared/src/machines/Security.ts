export type MachineIdentity = { machine_id: string; noise_key: string; box_key: string }
export type ClientIdentity = { signing_key: string; box_key: string }
export type ClientIdentityDisplay = { identity: ClientIdentity; fingerprint: string }
export type MachineSecurity = {
  randomId: () => string
  publicIdentity: () => Promise<ClientIdentityDisplay>
  machines: () => Promise<Record<string, MachineIdentity>>
  pin: (identity: MachineIdentity) => Promise<void>
  sign: (machine: string, message: Record<string, any>) => Promise<Record<string, any>>
  seal: (machine: string, value: Record<string, any>) => Promise<Record<string, any>>
  open: (machine: string, value: Record<string, any>) => Promise<Record<string, any>>
}
let adapter: MachineSecurity | null = null
export let configureMachineSecurity = (security: MachineSecurity) => { adapter = security }
export let machineSecurity = () => {
  if (!adapter) throw new Error("Secure credential storage is unavailable on this client")
  return adapter
}
export let signedCommand = async (machine: string, message: Record<string, any>) => ({
  ...message,
  auth: await machineSecurity().sign(machine, message),
})
