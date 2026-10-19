import { useRouter } from "expo-router"
import { DemoWorkspace } from "../../src/components/DemoWorkspace"
import { useAuthStore } from "../../src/store/auth"

let DemoScreen = () => {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let connect = () => router.dismissTo(authenticated ? "/account" : "/login")
  return <DemoWorkspace onConnect={connect} />
}
export default DemoScreen
