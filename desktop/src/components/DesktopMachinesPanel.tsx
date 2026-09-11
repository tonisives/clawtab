import { AddMachineButton, ConnectMachine, ManageMachinesButton, MachineOnboardingProvider, MachinesPanel, RentalsPanel, useMachines } from "@clawtab/shared"
import { openUrl } from "@tauri-apps/plugin-opener"
import { approveDesktopMachine, localHostRequest, desktopMachineApi, localMachineId } from "../machines/connection"

export let DesktopMachinesPanel = ({ onOpenAccount, manage = true }: { onOpenAccount: () => void; manage?: boolean }) => {
  useMachines()
  return <MachineOnboardingProvider
    content={(close) => <DesktopMachinesPanel manage={false} onOpenAccount={() => { close(); onOpenAccount() }} />}
    management={(close) => <DesktopMachinesPanel onOpenAccount={() => { close(); onOpenAccount() }} />}
  >
    <div className="desktop-machines-panel">
      {manage && <AddMachineButton />}
      <RentalsPanel showExistingRentals={manage} allowNewRentals={!manage} api={desktopMachineApi} platform="desktop" purchases openUrl={openUrl} />
      {manage ? <MachinesPanel
        presentation="panel"
        localMachineId={localMachineId()}
        onOpenAccount={onOpenAccount}
        approvePairing={approveDesktopMachine}
        localRequest={localHostRequest}
        api={desktopMachineApi}
      /> : <><ConnectMachine approvePairing={approveDesktopMachine} /><ManageMachinesButton /></>}
    </div>
  </MachineOnboardingProvider>
}
