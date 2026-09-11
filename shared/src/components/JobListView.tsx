import { MachineOnboardingProvider } from "../machines/Onboarding";
import { JobListViewComponent } from "./JobListView/Component";
import { useJobListView } from "./JobListView/useJobListView";
import type { JobListViewProps } from "./JobListView/sign";

export type { JobListViewProps, SidebarSelectableItem } from "./JobListView/sign";

export function JobListView(props: JobListViewProps) {
  const hook = useJobListView(props);
  return <MachineOnboardingProvider content={props.machineOnboarding} management={props.machineManagement}><JobListViewComponent hook={hook} /></MachineOnboardingProvider>;
}
