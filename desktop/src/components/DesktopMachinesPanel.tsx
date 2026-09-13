import { useState } from "react"
import { ConnectMachine, ManageMachinesButton, MachineOnboardingProvider, MachinesPanel, RentalsPanel } from "@clawtab/shared"
import { openUrl } from "@tauri-apps/plugin-opener"
import { approveDesktopMachine, localHostRequest, desktopMachineApi, localMachineId } from "../machines/connection"
import { useRemoteConnection } from "../machines/remoteConnection"
import { RemoteConnectionStatus } from "./RemoteConnectionStatus"

export let DesktopMachinesPanel = ({ onOpenAccount, manage = true }: { onOpenAccount: () => void; manage?: boolean }) => {
  let [machineType, setMachineType] = useState<"personal" | "rented">("personal")
  let showPersonal = () => setMachineType("personal")
  let showRented = () => setMachineType("rented")
  let remote = useRemoteConnection()
  let available = remote.account === "ready" && remote.relay?.enabled && remote.relay.configured && remote.operation !== "disconnect"
  if (!available) return <div className="desktop-machines-panel">
    <RemoteConnectionStatus label={remote.label} phase={remote.phase} />
    {remote.error && <p role="alert">{remote.error}</p>}
    <button className="btn btn-primary" onClick={onOpenAccount}>Open Remote Access</button>
  </div>
  return <MachineOnboardingProvider
    content={(close) => <DesktopMachinesPanel manage={false} onOpenAccount={() => { close(); onOpenAccount() }} />}
    management={(close) => <DesktopMachinesPanel onOpenAccount={() => { close(); onOpenAccount() }} />}
  >
    <div className="desktop-machines-panel">
      <RemoteConnectionStatus label={remote.label} phase={remote.phase} />
      {remote.error && <p role="alert">{remote.error}</p>}
      {remote.phase !== "connected" && <button className="btn" onClick={onOpenAccount}>Open Remote Access</button>}
      {manage && <div className="desktop-machines-tabs" role="group" aria-label="Machine type">
        <button className="desktop-machines-tab" aria-pressed={machineType === "personal"} onClick={showPersonal}>Personal machines</button>
        <button className="desktop-machines-tab" aria-pressed={machineType === "rented"} onClick={showRented}>Rented boxes</button>
      </div>}
      <section className={manage ? "desktop-machines-management" : undefined} aria-label={manage ? (machineType === "personal" ? "Personal machines" : "Rented boxes") : "Add machine"}>
        {manage && <header className="desktop-machines-heading">
          <h3>{machineType === "personal" ? "Personal machines" : "Rented boxes"}</h3>
          <p>{machineType === "personal" ? "Connect and manage your own computers, including this Mac." : "Manage your rented servers, agent setup, payments, and renewals."}</p>
        </header>}
        {(!manage || machineType === "rented") && <RentalsPanel showExistingRentals={manage} api={desktopMachineApi} platform="desktop" purchases openUrl={openUrl} />}
        {manage ? <MachinesPanel
          key={machineType}
          machineType={machineType}
          presentation="panel"
          showConnectionStatus={false}
          localMachineId={localMachineId()}
          onOpenAccount={onOpenAccount}
          approvePairing={approveDesktopMachine}
          localRequest={localHostRequest}
          api={desktopMachineApi}
        /> : <><ConnectMachine approvePairing={approveDesktopMachine} /><ManageMachinesButton /></>}
      </section>
    </div>
  </MachineOnboardingProvider>
}
