import { useLocalSearchParams } from "expo-router"
import { MachineSetup } from "../src/components/MachineSetup"
import { SettingsPage } from "../src/components/settings/SettingsPage"

let AddMachineScreen = () => {
  let { setup } = useLocalSearchParams<{ setup?: string }>()
  return <SettingsPage wide><MachineSetup setup={setup === "connect" || setup === "rent" ? setup : undefined} /></SettingsPage>
}
export default AddMachineScreen
