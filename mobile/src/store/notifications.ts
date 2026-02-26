import { create } from "zustand";
import type { ClaudeQuestion, NotificationHistoryItem } from "../types/job";

interface NotificationState {
  questions: ClaudeQuestion[];
  deepLinkQuestionId: string | null;
  expanded: boolean;

  setQuestions: (questions: ClaudeQuestion[]) => void;
  answerQuestion: (questionId: string) => void;
  setDeepLinkQuestionId: (id: string | null) => void;
  setExpanded: (expanded: boolean) => void;
  hydrateFromHistory: (items: NotificationHistoryItem[]) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  questions: [],
  deepLinkQuestionId: null,
  expanded: false,

  setQuestions: (questions) =>
    set((state) => {
      // Merge: keep any existing unanswered questions not in the new batch,
      // add new questions that don't already exist
      const existingIds = new Set(state.questions.map((q) => q.question_id));
      const newIds = new Set(questions.map((q) => q.question_id));

      // Keep questions from new batch + existing ones not covered by new batch
      const merged = [
        ...questions,
        ...state.questions.filter((q) => !newIds.has(q.question_id)),
      ];

      return { questions: merged };
    }),

  answerQuestion: (questionId) =>
    set((state) => ({
      questions: state.questions.filter((q) => q.question_id !== questionId),
    })),

  setDeepLinkQuestionId: (id) => set({ deepLinkQuestionId: id, expanded: !!id }),

  setExpanded: (expanded) => set({ expanded }),

  hydrateFromHistory: (items) =>
    set((state) => {
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
        }));

      return {
        questions: [...state.questions, ...newQuestions],
      };
    }),
}));
