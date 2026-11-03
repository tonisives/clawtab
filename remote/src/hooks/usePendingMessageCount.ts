import { messagePending } from "@clawtab/shared";
import { useJobsStore } from "../store/jobs";
import { questionMessage, uncoveredAlerts, useMessageStore } from "../store/messages";
import { useNotificationStore } from "../store/notifications";
import { useDemoMode } from "./useDemoMode";
import { useDemoMessages } from "../demo/messages";

export function usePendingMessageCount() {
  const demo = useDemoMode();
  const demoRecords = useDemoMessages(state => state.records);
  const questions = useNotificationStore(state => state.questions);
  const records = useMessageStore(state => state.records);
  const processes = useJobsStore(state => state.detectedProcesses);
  const alertCount = uncoveredAlerts(records, processes).filter(process => process._agent_alert?.trim()).length;
  const represented = new Set(questions.map(question => questionMessage(records, question)));
  const messageCount = records.filter(record => messagePending(record) && !represented.has(record)).length;
  return demo ? demoRecords.filter(messagePending).length : questions.length + alertCount + messageCount;
}
