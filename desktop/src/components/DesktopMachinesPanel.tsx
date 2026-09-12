import { AddMachineButton, ConnectMachine, ManageMachinesButton, MachineOnboardingProvider, MachinesPanel, RentalsPanel } from "@clawtab/shared"
import { openUrl } from "@tauri-apps/plugin-opener"
import { approveDesktopMachine, localHostRequest, desktopMachineApi, localMachineId } from "../machines/connection"
import { useRemoteConnection } from "../machines/remoteConnection"

export let DesktopMachinesPanel = ({ onOpenAccount, manage = true }: { onOpenAccount: () => void; manage?: boolean }) => {
  let remote = useRemoteConnection()
  let available = remote.account === "ready" && remote.relay?.enabled && remote.relay.configured && remote.operation !== "disconnect"
  if (!available) return <div className="desktop-machines-panel">
    <p role="status">{remote.label}</p>
    {remote.error && <p role="alert">{remote.error}</p>}
    <button className="btn btn-primary" onClick={onOpenAccount}>Open Remote Access</button>
  </div>
  return <MachineOnboardingProvider
    content={(close) => <DesktopMachinesPanel manage={false} onOpenAccount={() => { close(); onOpenAccount() }} />}
    management={(close) => <DesktopMachinesPanel onOpenAccount={() => { close(); onOpenAccount() }} />}
  >
    <div className="desktop-machines-panel">
      <p role="status">{remote.label}</p>
      {remote.error && <p role="alert">{remote.error}</p>}
      {remote.phase !== "connected" && <button className="btn" onClick={onOpenAccount}>Open Remote Access</button>}
      {manage && <AddMachineButton />}
      <RentalsPanel showExistingRentals={manage} allowNewRentals={!manage} api={desktopMachineApi} platform="desktop" purchases openUrl={openUrl} />
      {manage ? <MachinesPanel
        presentation="panel"
        showConnectionStatus={false}
        localMachineId={localMachineId()}
        onOpenAccount={onOpenAccount}
        approvePairing={approveDesktopMachine}
        localRequest={localHostRequest}
        api={desktopMachineApi}
      /> : <><ConnectMachine approvePairing={approveDesktopMachine} /><ManageMachinesButton /></>}
    </div>
  </MachineOnboardingProvider>
}
