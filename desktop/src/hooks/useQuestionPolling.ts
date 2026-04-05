import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeQuestion, ClaudeProcess } from "@clawtab/shared";
import type { Job } from "../types";

export function useQuestionPolling() {
  const [questions, setQuestions] = useState<ClaudeQuestion[]>([]);
  const questionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedRef = useRef<Map<string, number>>(new Map());

  const loadQuestions = useCallback(() => {
    invoke<ClaudeQuestion[]>("get_active_questions").then((qs) => {
      console.log("[nfn] loadQuestions got", qs.length, "questions");
      const now = Date.now();
      for (const [id, ts] of dismissedRef.current) {
        if (now - ts > 10000) dismissedRef.current.delete(id);
      }
      setQuestions(qs.filter((q) => !dismissedRef.current.has(q.question_id)));
    }).catch((e) => { console.error("[nfn] loadQuestions error", e); });
  }, []);

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
    setQuestions((prev) => prev.filter((q) => q.question_id !== questionId));
    startFastQuestionPoll();
  }, [startFastQuestionPoll]);

  const handleQuestionNavigate = useCallback((
    q: ClaudeQuestion,
    resolvedJob: string | null,
    jobs: Job[],
    processes: ClaudeProcess[],
    setViewingJob: (job: Job | null) => void,
    setViewingProcess: (proc: ClaudeProcess | null) => void,
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
    if (resolvedJob) {
      invoke("send_job_input", { name: resolvedJob, text: optionNumber }).catch(() => {});
    } else {
      invoke("send_detected_process_input", { paneId: q.pane_id, text: optionNumber }).catch(() => {});
    }
    dismissedRef.current.set(q.question_id, Date.now());
    startFastQuestionPoll();
    setTimeout(() => {
      setQuestions((prev) => prev.filter((pq) => pq.question_id !== q.question_id));
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
