import { useRouter } from "expo-router"
import { DemoOverview } from "../src/components/DemoOverview"
import { useAuthStore } from "../src/store/auth"

export default function DemoOverviewScreen() {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let connect = () => authenticated ? router.push("/account") : router.push({ pathname: "/login", params: { return_to: "account" } })
  return <DemoOverview onConnect={connect} />
}
