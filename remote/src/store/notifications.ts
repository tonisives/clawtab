import { create } from "zustand";
import type { ClaudeQuestion, NotificationHistoryItem } from "../types/job";

interface NotificationState {
  questions: ClaudeQuestion[];
  deepLinkQuestionId: string | null;
  // Once the desktop sends authoritative claude_questions, ignore history hydration
  hasDesktopQuestions: boolean;
  // Recently dismissed question IDs (optimistic removal) - prevents re-polling
  // from bringing them back before the desktop has consumed the answer.
  dismissedIds: Map<string, number>;
  // Pane IDs with "yes to all" enabled - auto-answers questions with "yes"
  autoYesPaneIds: Set<string>;

  setQuestions: (questions: ClaudeQuestion[]) => void;
  answerQuestion: (questionId: string) => void;
  setDeepLinkQuestionId: (id: string | null) => void;
  hydrateFromHistory: (items: NotificationHistoryItem[]) => void;
  injectFromNotification: (question: ClaudeQuestion) => void;
  hydrateQuestionsFromCache: (questions: ClaudeQuestion[]) => void;
  enableAutoYes: (paneId: string) => void;
  disableAutoYes: (paneId: string) => void;
  setAutoYesPanes: (paneIds: string[]) => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  questions: [],
  deepLinkQuestionId: null,
  hasDesktopQuestions: false,
  dismissedIds: new Map(),
  autoYesPaneIds: new Set(),

  setQuestions: (questions) =>
    set(() => {
      const dismissed = get().dismissedIds;
      const now = Date.now();
      // Purge stale dismissals (>10s)
      for (const [id, ts] of dismissed) {
        if (now - ts > 10000) dismissed.delete(id);
      }
      return {
        questions: questions.filter((q) => !dismissed.has(q.question_id)),
        hasDesktopQuestions: true,
      };
    }),

  answerQuestion: (questionId) =>
    set((state) => {
      state.dismissedIds.set(questionId, Date.now());
      return {
        questions: state.questions.filter((q) => q.question_id !== questionId),
      };
    }),

  setDeepLinkQuestionId: (id) => set({ deepLinkQuestionId: id }),

  hydrateFromHistory: (items) =>
    set((state) => {
      // Skip history hydration once desktop has sent the authoritative list
      if (state.hasDesktopQuestions) return state;

      const existingIds = new Set(state.questions.map((q) => q.question_id));
      const newQuestions: ClaudeQuestion[] = items
        .filter((item) => !item.answered && !existingIds.has(item.question_id))
        .map((item) => ({
          pane_id: item.pane_id,
          cwd: item.cwd,
          tmux_session: "",
          window_name: "",
          question_id: item.question_id,
          context_lines: item.context_lines,
          options: item.options,
          matched_job: (item as { matched_job?: string }).matched_job ?? null,
          matched_group: (item as { matched_group?: string }).matched_group ?? null,
        }));

      return {
        questions: [...state.questions, ...newQuestions],
      };
    }),

  injectFromNotification: (question) =>
    set((state) => {
      if (state.questions.some((q) => q.question_id === question.question_id)) {
        return state;
      }
      return { questions: [...state.questions, question] };
    }),

  hydrateQuestionsFromCache: (questions) =>
    set((state) => {
      if (state.hasDesktopQuestions) return state;
      return { questions };
    }),

  enableAutoYes: (paneId) =>
    set((state) => {
      const next = new Set(state.autoYesPaneIds);
      next.add(paneId);
      return { autoYesPaneIds: next };
    }),

  disableAutoYes: (paneId) =>
    set((state) => {
      const next = new Set(state.autoYesPaneIds);
      next.delete(paneId);
      return { autoYesPaneIds: next };
    }),

  setAutoYesPanes: (paneIds) =>
    set(() => ({ autoYesPaneIds: new Set(paneIds) })),

  reset: () => set({ questions: [], hasDesktopQuestions: false, dismissedIds: new Map(), autoYesPaneIds: new Set() }),
}));
