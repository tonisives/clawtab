import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RemoteJob, JobStatus, ClaudeQuestion } from "../types/job";

const KEY_JOBS = "clawtab_cached_jobs";
const KEY_STATUSES = "clawtab_cached_statuses";
const KEY_QUESTIONS = "clawtab_cached_questions";

let jobsTimer: ReturnType<typeof setTimeout> | undefined;

export function saveJobsCache(
  jobs: RemoteJob[],
  statuses: Record<string, JobStatus>,
) {
  if (jobsTimer) clearTimeout(jobsTimer);
  jobsTimer = setTimeout(() => {
    AsyncStorage.multiSet([
      [KEY_JOBS, JSON.stringify(jobs)],
      [KEY_STATUSES, JSON.stringify(statuses)],
    ]).catch((e) => console.log("[cache] failed to save jobs:", e));
  }, 500);
}

export function saveQuestionsCache(questions: ClaudeQuestion[]) {
  AsyncStorage.setItem(KEY_QUESTIONS, JSON.stringify(questions)).catch((e) =>
    console.log("[cache] failed to save questions:", e),
  );
}

export async function loadCache(): Promise<{
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  questions: ClaudeQuestion[];
} | null> {
  try {
    const results = await AsyncStorage.multiGet([
      KEY_JOBS,
      KEY_STATUSES,
      KEY_QUESTIONS,
    ]);
    const rawJobs = results[0][1];
    const rawStatuses = results[1][1];
    const rawQuestions = results[2][1];
    if (!rawJobs) return null;
    return {
      jobs: JSON.parse(rawJobs),
      statuses: rawStatuses ? JSON.parse(rawStatuses) : {},
      questions: rawQuestions ? JSON.parse(rawQuestions) : [],
    };
  } catch (e) {
    console.log("[cache] failed to load:", e);
    return null;
  }
}

export async function clearCache() {
  try {
    await AsyncStorage.multiRemove([KEY_JOBS, KEY_STATUSES, KEY_QUESTIONS]);
  } catch (e) {
    console.log("[cache] failed to clear:", e);
  }
}
