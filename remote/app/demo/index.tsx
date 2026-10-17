import { useRouter } from "expo-router"
import { DemoJobList } from "../../src/components/DemoJobList"
import { useAuthStore } from "../../src/store/auth"

let DemoScreen = () => {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let connect = () => router.dismissTo(authenticated ? "/settings" : "/login")
  return <DemoJobList onConnect={connect} />
}
export default DemoScreen
