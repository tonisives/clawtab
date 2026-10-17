import { useRouter } from "expo-router"
import { AccountSettings } from "../src/components/settings/AccountSettings"
import { SettingsNavigation } from "../src/components/settings/navigation"

let AccountScreen = () => {
  let router = useRouter()
  let navigate = () => router.push("/machines")
  return <SettingsNavigation.Provider value={navigate}><AccountSettings /></SettingsNavigation.Provider>
}
export default AccountScreen
