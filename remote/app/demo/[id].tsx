import { useLocalSearchParams } from "expo-router"
import { DemoDetailsContent } from "../../src/components/DemoDetailsContent"

let DemoDetails = () => {
  let params = useLocalSearchParams<{ id: string; kind?: string }>()
  return <DemoDetailsContent {...params} />
}
export default DemoDetails
