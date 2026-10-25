import { useRouter } from "expo-router"
import { DemoWorkspace } from "../../src/components/DemoWorkspace"
import { useAuthStore } from "../../src/store/auth"

let DemoScreen = () => {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let connect = () => authenticated ? router.dismissTo("/workspace") : router.dismissTo({ pathname: "/login", params: { return_to: "workspace" } })
  return <DemoWorkspace onConnect={connect} />
}
export default DemoScreen
