import { create } from "zustand";
import type { ClaudeQuestion, NotificationHistoryItem } from "../types/job";

type NotificationState = {
  questions: ClaudeQuestion[];
  deepLinkQuestionId: string | null;
  // Once the desktop sends authoritative claude_questions, ignore history hydration
  hasDesktopQuestions: boolean;
  // Recently dismissed question IDs (optimistic removal) - prevents re-polling
  // from bringing them back before the desktop has consumed the answer.
  dismissedIds: Map<string, number>;
  // Pane IDs with Auto Yes enabled for approvals. Planning stays manual.
  autoYesPaneIds: Set<string>;
  authoritativeAutoYesPaneIds: Set<string>;
  pendingAutoYes: Map<string, boolean>;

  setQuestions: (questions: ClaudeQuestion[]) => void;
  answerQuestion: (questionId: string) => void;
  setDeepLinkQuestionId: (id: string | null) => void;
  hydrateFromHistory: (items: NotificationHistoryItem[]) => void;
  injectFromNotification: (question: ClaudeQuestion) => void;
  hydrateQuestionsFromCache: (questions: ClaudeQuestion[]) => void;
  enableAutoYes: (paneId: string) => void;
  disableAutoYes: (paneId: string) => void;
  setAutoYesPanes: (paneIds: string[]) => void;
  beginAutoYes: (paneId: string, enabled: boolean) => void;
  finishAutoYes: (paneId: string, success: boolean) => void;
  reset: () => void;
}

const autoYesApplies = (question: Pick<ClaudeQuestion, "pane_id" | "requires_manual_answer">, panes: Set<string>) => (
  !question.requires_manual_answer && panes.has(question.pane_id)
);

export const useNotificationStore = create<NotificationState>((set) => ({
  questions: [],
  deepLinkQuestionId: null,
  hasDesktopQuestions: false,
  dismissedIds: new Map(),
  autoYesPaneIds: new Set(),
  authoritativeAutoYesPaneIds: new Set(),
  pendingAutoYes: new Map(),

  setQuestions: (questions) =>
    set((state) => {
      const dismissed = state.dismissedIds;
      const now = Date.now();
      // Purge stale dismissals (>10s)
      for (const [id, ts] of dismissed) {
        if (now - ts > 10000) dismissed.delete(id);
      }
      return {
        questions: questions.filter((q) => (
          !dismissed.has(q.question_id) && !autoYesApplies(q, state.autoYesPaneIds)
        )),
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
        .filter((item) => (
          !item.answered
          && !existingIds.has(item.question_id)
          && !autoYesApplies(item, state.autoYesPaneIds)
        ))
        .map((item) => ({
          pane_id: item.pane_id,
          cwd: item.cwd,
          tmux_session: "",
          window_name: "",
          question_id: item.question_id,
          context_lines: item.context_lines,
          options: item.options,
          requires_manual_answer: item.requires_manual_answer,
          matched_job: (item as { matched_job?: string }).matched_job ?? null,
          matched_group: (item as { matched_group?: string }).matched_group ?? null,
        }));

      return {
        questions: [...state.questions, ...newQuestions],
      };
    }),

  injectFromNotification: (question) =>
    set((state) => {
      if (autoYesApplies(question, state.autoYesPaneIds)) {
        return state;
      }
      if (state.questions.some((q) => q.question_id === question.question_id)) {
        return state;
      }
      return { questions: [...state.questions, question] };
    }),

  hydrateQuestionsFromCache: (questions) =>
    set((state) => {
      if (state.hasDesktopQuestions) return state;
      return {
        questions: questions.filter((q) => !autoYesApplies(q, state.autoYesPaneIds)),
      };
    }),

  enableAutoYes: (paneId) =>
    set((state) => {
      const next = new Set(state.autoYesPaneIds);
      next.add(paneId);
      let authoritativeAutoYesPaneIds = new Set(state.authoritativeAutoYesPaneIds);
      authoritativeAutoYesPaneIds.add(paneId);
      return {
        autoYesPaneIds: next,
        authoritativeAutoYesPaneIds,
        questions: state.questions.filter((q) => !autoYesApplies(q, next)),
      };
    }),

  disableAutoYes: (paneId) =>
    set((state) => {
      const next = new Set(state.autoYesPaneIds);
      next.delete(paneId);
      let authoritativeAutoYesPaneIds = new Set(state.authoritativeAutoYesPaneIds);
      authoritativeAutoYesPaneIds.delete(paneId);
      return { autoYesPaneIds: next, authoritativeAutoYesPaneIds };
    }),

  setAutoYesPanes: (paneIds) =>
    set((state) => {
      const autoYesPaneIds = new Set(paneIds);
      for (let [paneId, enabled] of state.pendingAutoYes) {
        if (enabled) autoYesPaneIds.add(paneId);
        else autoYesPaneIds.delete(paneId);
      }
      return {
        autoYesPaneIds,
        authoritativeAutoYesPaneIds: new Set(paneIds),
        questions: state.questions.filter((q) => !autoYesApplies(q, autoYesPaneIds)),
      };
    }),

  beginAutoYes: (paneId, enabled) => set((state) => {
    let pendingAutoYes = new Map(state.pendingAutoYes);
    pendingAutoYes.set(paneId, enabled);
    let autoYesPaneIds = new Set(state.autoYesPaneIds);
    if (enabled) autoYesPaneIds.add(paneId);
    else autoYesPaneIds.delete(paneId);
    return { pendingAutoYes, autoYesPaneIds };
  }),

  finishAutoYes: (paneId, success) => set((state) => {
    let enabled = state.pendingAutoYes.get(paneId);
    if (enabled === undefined) return state;
    let pendingAutoYes = new Map(state.pendingAutoYes);
    pendingAutoYes.delete(paneId);
    let authoritativeAutoYesPaneIds = new Set(state.authoritativeAutoYesPaneIds);
    if (success) {
      if (enabled) authoritativeAutoYesPaneIds.add(paneId);
      else authoritativeAutoYesPaneIds.delete(paneId);
    }
    let autoYesPaneIds = new Set(authoritativeAutoYesPaneIds);
    for (let [id, value] of pendingAutoYes) {
      if (value) autoYesPaneIds.add(id);
      else autoYesPaneIds.delete(id);
    }
    return { pendingAutoYes, authoritativeAutoYesPaneIds, autoYesPaneIds };
  }),

  reset: () => set({ questions: [], deepLinkQuestionId: null, hasDesktopQuestions: false, dismissedIds: new Map(), autoYesPaneIds: new Set(), authoritativeAutoYesPaneIds: new Set(), pendingAutoYes: new Map() }),
}));
