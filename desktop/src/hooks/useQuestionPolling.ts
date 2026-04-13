import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeQuestion, DetectedProcess } from "@clawtab/shared";
import type { Job } from "../types";

export function useQuestionPolling(options?: { onTick?: () => void }) {
  const [questions, setQuestions] = useState<ClaudeQuestion[]>([]);
  const questionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedRef = useRef<Map<string, number>>(new Map());
  const questionsSigRef = useRef("[]");

  const signatureForQuestions = (qs: ClaudeQuestion[]) =>
    JSON.stringify(qs.map((q) => [
      q.question_id,
      q.pane_id,
      q.matched_job,
      q.tmux_session,
      q.window_name,
      q.context_lines,
      q.options,
    ]));

  const loadQuestions = useCallback(() => {
    options?.onTick?.();
    invoke<ClaudeQuestion[]>("get_active_questions").then((qs) => {
      console.log("[nfn] loadQuestions got", qs.length, "questions");
      const now = Date.now();
      for (const [id, ts] of dismissedRef.current) {
        if (now - ts > 10000) dismissedRef.current.delete(id);
      }
      const filtered = qs.filter((q) => !dismissedRef.current.has(q.question_id));
      const nextSig = signatureForQuestions(filtered);
      if (nextSig === questionsSigRef.current) return;
      questionsSigRef.current = nextSig;
      setQuestions(filtered);
    }).catch((e) => { console.error("[nfn] loadQuestions error", e); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.onTick]);

  useEffect(() => {
    console.log("[nfn] mounting, calling loadQuestions immediately");
    loadQuestions();
    questionPollRef.current = setInterval(loadQuestions, 5000);
    return () => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    };
  }, [loadQuestions]);

  const startFastQuestionPoll = useCallback(() => {
    if (questionPollRef.current) clearInterval(questionPollRef.current);
    if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    questionPollRef.current = setInterval(loadQuestions, 500);
    fastPollTimerRef.current = setTimeout(() => {
      if (questionPollRef.current) clearInterval(questionPollRef.current);
      questionPollRef.current = setInterval(loadQuestions, 5000);
    }, 5000);
  }, [loadQuestions]);

  const dismissQuestion = useCallback((questionId: string) => {
    dismissedRef.current.set(questionId, Date.now());
    setQuestions((prev) => {
      const next = prev.filter((q) => q.question_id !== questionId);
      questionsSigRef.current = signatureForQuestions(next);
      return next;
    });
    startFastQuestionPoll();
  }, [startFastQuestionPoll]);

  const handleQuestionNavigate = useCallback((
    q: ClaudeQuestion,
    resolvedJob: string | null,
    jobs: Job[],
    processes: DetectedProcess[],
    setViewingJob: (job: Job | null) => void,
    setViewingProcess: (proc: DetectedProcess | null) => void,
  ) => {
    if (resolvedJob) {
      const job = jobs.find((j) => j.slug === resolvedJob);
      if (job) { setViewingJob(job); return; }
    }
    const proc = processes.find((p) => p.pane_id === q.pane_id);
    if (proc) {
      setViewingProcess(proc);
    } else {
      invoke("focus_detected_process", {
        tmuxSession: q.tmux_session,
        windowName: q.window_name,
      }).catch(() => {});
    }
  }, []);

  const handleQuestionSendOption = useCallback((q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
    // For opencode select-mode, find the option to get its col position and use mouse click
    const opt = q.input_mode === "select"
      ? q.options.find((o) => o.number === optionNumber)
      : undefined;
    const col = opt?.col;
    const row = q.input_mode === "select" ? q.button_row : undefined;

    if (resolvedJob) {
      invoke("send_job_input", { name: resolvedJob, text: optionNumber, col, row }).catch(() => {});
    } else {
      invoke("send_detected_process_input", { paneId: q.pane_id, text: optionNumber, col, row }).catch(() => {});
    }
    dismissedRef.current.set(q.question_id, Date.now());
    startFastQuestionPoll();
    setTimeout(() => {
      setQuestions((prev) => {
        const next = prev.filter((pq) => pq.question_id !== q.question_id);
        questionsSigRef.current = signatureForQuestions(next);
        return next;
      });
    }, 750);
  }, [startFastQuestionPoll]);

  const resolveQuestionJob = useCallback(
    (q: ClaudeQuestion) => q.matched_job ?? null,
    [],
  );

  return {
    questions,
    setQuestions,
    dismissQuestion,
    startFastQuestionPoll,
    handleQuestionNavigate,
    handleQuestionSendOption,
    resolveQuestionJob,
  };
}
