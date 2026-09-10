import { useState } from "react"
import { View, Text, Pressable, TextInput, StyleSheet } from "react-native"
import { AgentActionFormModal } from "../components/AgentActionFormModal"
import type { AgentActionDescriptor } from "../types/agentPlugin"
import { useMachines, machineRequest, type MachineMessage } from "./client"

type Props = { machineId: string; paneId: string; controlled: boolean }
export let MachineActions = ({ machineId, paneId, controlled }: Props) => {
  let state = useMachines()
  let [actions, setActions] = useState<AgentActionDescriptor[]>([])
  let [selected, setSelected] = useState<AgentActionDescriptor | null>(null)
  let [result, setResult] = useState<MachineMessage | null>(null)
  let [error, setError] = useState<string | null>(null)
  let [busy, setBusy] = useState(false)
  let [stopConfirm, setStopConfirm] = useState(false)
  let [answer, setAnswer] = useState("")
  let questions: MachineMessage[] =
    state.snapshots[machineId]?.claude_questions?.questions?.filter(
      (question: MachineMessage) => question.pane_id === paneId,
    ) ?? []
  let act = async (message: MachineMessage) => {
    setBusy(true)
    setError(null)
    try {
      let response = await machineRequest(machineId, { ...message, pane_id: paneId })
      setResult(response)
      return response
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed")
      return null
    } finally {
      setBusy(false)
    }
  }
  let load = async () => {
    let response = await act({ type: "list_agent_actions" })
    if (response) setActions(response.actions ?? [])
  }
  let close = () => setSelected(null)
  let submit = async (parameters: Record<string, string>) => {
    if (!selected) return
    let response = await act({ type: "start_agent_action", action_id: selected.id, parameters })
    if (response) setSelected(null)
  }
  let refreshRun = () => void act({ type: "get_agent_action_run", run_id: result?.run?.run_id })
  let cancelRun = () => void act({ type: "cancel_agent_action", run_id: result?.run?.run_id })
  let toggleStop = () => setStopConfirm(!stopConfirm)
  let stop = () => void act({ type: "stop_detected_process" }).then(() => setStopConfirm(false))
  let sendAnswer = (question: MachineMessage) => () =>
    void act({ type: "answer_question", question_id: question.question_id, answer })
  let chooseAction = (action: AgentActionDescriptor) => () => setSelected(action)
  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={load} disabled={busy} style={styles.button}>
          <Text style={styles.text}>Agent actions</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={toggleStop}
          disabled={busy}
          style={styles.button}
        >
          <Text style={styles.text}>Stop session</Text>
        </Pressable>
        {stopConfirm && (
          <Pressable
            accessibilityRole="button"
            onPress={stop}
            disabled={busy}
            style={styles.button}
          >
            <Text style={styles.text}>Confirm stop</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.row}>
        {actions.map((action) => (
          <Pressable
            accessibilityRole="button"
            key={action.id}
            disabled={!controlled || !action.available || busy}
            onPress={chooseAction(action)}
            style={styles.button}
          >
            <Text style={styles.text}>
              {action.title}
              {action.unavailable_reason ? ` · ${action.unavailable_reason}` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      {questions.map((question) => (
        <View key={question.question_id}>
          <Text selectable style={styles.text}>
            {question.context_lines?.join("\n")}
          </Text>
          <Text style={styles.text}>
            {question.options
              ?.map((option: MachineMessage) => `${option.number}. ${option.label}`)
              .join("\n")}
          </Text>
          <TextInput
            accessibilityLabel="Answer"
            placeholder="Option number or answer"
            placeholderTextColor="#989ca6"
            style={styles.input}
            value={answer}
            onChangeText={setAnswer}
          />
          <Pressable
            accessibilityRole="button"
            onPress={sendAnswer(question)}
            disabled={busy || !answer}
            style={styles.button}
          >
            <Text style={styles.text}>Answer</Text>
          </Pressable>
        </View>
      ))}
      {result?.run && (
        <View style={styles.row}>
          <Text style={styles.text}>{result.run.status}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={refreshRun}
            disabled={busy}
            style={styles.button}
          >
            <Text style={styles.text}>Check action</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={cancelRun}
            disabled={busy}
            style={styles.button}
          >
            <Text style={styles.text}>Cancel action</Text>
          </Pressable>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <AgentActionFormModal
        action={selected}
        visible={!!selected}
        onClose={close}
        onSubmit={submit}
        submitting={busy}
      />
    </View>
  )
}
let styles = StyleSheet.create({
  panel: { paddingHorizontal: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  button: { paddingHorizontal: 16, paddingVertical: 10, minHeight: 44, justifyContent: "center", backgroundColor: "#353942", borderRadius: 999 },
  text: { color: "#e5e7eb", fontSize: 12 },
  error: { color: "#ffabab" },
  input: { color: "#fff", padding: 8, borderColor: "#50545d", borderWidth: 1 },
})
