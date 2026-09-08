import { MachinesPanel } from "@clawtab/shared"
import { approveDesktopMachine, localHostRequest, desktopMachineApi } from "../machines/connection"

export let DesktopMachinesPanel = () => (
  <div className="desktop-machines-panel">
    <p className="section-description">Connect a Linux host, then choose where to run your agents and jobs.</p>
    <MachinesPanel
      presentation="panel"
      approvePairing={approveDesktopMachine}
      localRequest={localHostRequest}
      api={desktopMachineApi}
    />
  </div>
)
