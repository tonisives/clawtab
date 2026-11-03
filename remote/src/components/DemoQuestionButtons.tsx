import type { ClaudeQuestion } from "@clawtab/shared"
import { OptionButtons } from "../../../shared/src/components/JobDetailView/Options"

let ignoreAnswer = () => {}

export let DemoQuestionButtons = ({ question, bottomInset = 0 }: { question: ClaudeQuestion; bottomInset?: number }) => (
  <OptionButtons options={question.options} onSend={ignoreAnswer} bottomInset={bottomInset} />
)
