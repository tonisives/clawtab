import { MachinesPanel, RentalsPanel, useMachines } from "@clawtab/shared"
import { openUrl } from "@tauri-apps/plugin-opener"
import { approveDesktopMachine, localHostRequest, desktopMachineApi, localMachineId } from "../machines/connection"

export let DesktopMachinesPanel = ({ onOpenAccount }: { onOpenAccount: () => void }) => {
  useMachines()
  return (
    <div className="desktop-machines-panel">
      <p className="section-description">Connect a Linux host, then choose where to run your agents and jobs.</p>
      <RentalsPanel api={desktopMachineApi} platform="desktop" purchases openUrl={openUrl} />
      <MachinesPanel
        presentation="panel"
        localMachineId={localMachineId()}
        onOpenAccount={onOpenAccount}
        approvePairing={approveDesktopMachine}
        localRequest={localHostRequest}
        api={desktopMachineApi}
      />
    </div>
  )
}
