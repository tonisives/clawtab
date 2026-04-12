import { useEffect, useMemo, useRef, useState } from "react";
import type { AutoYesEntry, ClaudeQuestion, useJobsCore } from "@clawtab/shared";
import { AutoYesBanner, NotificationSection } from "@clawtab/shared";
import { DraggableNotificationCard } from "../../DraggableCards";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useQuestionPolling } from "../../../hooks/useQuestionPolling";

interface UseJobsNotificationsParams {
  autoYes: ReturnType<typeof useAutoYes>;
  core: ReturnType<typeof useJobsCore>;
  handleAutoYesPress: (entry: AutoYesEntry) => void;
  handleQuestionNavigate: (question: ClaudeQuestion, resolvedJob: string | null) => void;
  isWide: boolean;
  questionPolling: ReturnType<typeof useQuestionPolling>;
  questions: ClaudeQuestion[];
}

export function useJobsNotifications({
  autoYes,
  core,
  handleAutoYesPress,
  handleQuestionNavigate,
  isWide,
  questionPolling,
  questions,
}: UseJobsNotificationsParams) {
  const [nfnVisible, setNfnVisible] = useState(questions.length > 0);
  const nfnHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (questions.length > 0) {
      if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current);
      setNfnVisible(true);
    } else {
      nfnHideTimer.current = setTimeout(() => setNfnVisible(false), 500);
    }
    return () => { if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current); };
  }, [questions.length]);

  return useMemo(() => {
    if (!nfnVisible && autoYes.autoYesEntries.length === 0) return undefined;
    return (
      <>
        <AutoYesBanner entries={autoYes.autoYesEntries} onDisable={autoYes.handleDisableAutoYes} onPress={handleAutoYesPress} />
        {nfnVisible && (
          <NotificationSection
            questions={questions}
            resolveJob={questionPolling.resolveQuestionJob}
            onNavigate={handleQuestionNavigate}
            onSendOption={questionPolling.handleQuestionSendOption}
            collapsed={core.collapsedGroups.has("Notifications")}
            onToggleCollapse={() => core.toggleGroup("Notifications")}
            autoYesPaneIds={autoYes.autoYesPaneIds}
            onToggleAutoYes={autoYes.handleToggleAutoYes}
            wrapQuestionCard={isWide ? (question, card) => (
              <DraggableNotificationCard
                question={question}
                resolvedJob={questionPolling.resolveQuestionJob(question)}
              >
                {card}
              </DraggableNotificationCard>
            ) : undefined}
          />
        )}
      </>
    );
  }, [nfnVisible, questions, questionPolling, handleQuestionNavigate, core.collapsedGroups, core.toggleGroup, autoYes, handleAutoYesPress, isWide]);
}
