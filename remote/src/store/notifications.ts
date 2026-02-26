import { create } from "zustand";
import type { ClaudeQuestion, NotificationHistoryItem } from "../types/job";

interface NotificationState {
  questions: ClaudeQuestion[];
  deepLinkQuestionId: string | null;
  // Once the desktop sends authoritative claude_questions, ignore history hydration
  hasDesktopQuestions: boolean;

  setQuestions: (questions: ClaudeQuestion[]) => void;
  answerQuestion: (questionId: string) => void;
  setDeepLinkQuestionId: (id: string | null) => void;
  hydrateFromHistory: (items: NotificationHistoryItem[]) => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  questions: [],
  deepLinkQuestionId: null,
  hasDesktopQuestions: false,

  setQuestions: (questions) =>
    set(() => ({
      // Replace: the desktop sends the full current set of active questions.
      questions,
      hasDesktopQuestions: true,
    })),

  answerQuestion: (questionId) =>
    set((state) => ({
      questions: state.questions.filter((q) => q.question_id !== questionId),
    })),

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

  reset: () => set({ questions: [], hasDesktopQuestions: false }),
}));
