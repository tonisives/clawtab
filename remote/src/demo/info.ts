import { Alert, Platform } from "react-native"

export let showDemoInfo = () => {
  let title = "Demo mode"
  let message = "You're viewing sample agents, jobs, and output. Prompts you type here are not sent to an agent, and agent actions are disabled. Connect a machine through your relay to view live sessions and run agents."
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`)
    return
  }
  Alert.alert(title, message)
}
