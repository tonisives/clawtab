import { useOpenRelay } from "../src/hooks/useOpenRelay"
import { useRouter } from "expo-router"
import { DemoOverview } from "../src/components/DemoOverview"
import { useAuthStore } from "../src/store/auth"

export default function DemoOverviewScreen() {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let openRelay = useOpenRelay("push")
  let connect = () => authenticated ? openRelay() : router.push({ pathname: "/login", params: { return_to: "workspace" } })
  return <DemoOverview onConnect={connect} />
}
