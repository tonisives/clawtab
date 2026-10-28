import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RemoteJob, JobStatus, ClaudeQuestion } from "../types/job";

const KEY_JOBS = "clawtab_cached_jobs";
const KEY_STATUSES = "clawtab_cached_statuses";
const KEY_QUESTIONS = "clawtab_cached_questions";
const keys = (user: string) => [KEY_JOBS, KEY_STATUSES, KEY_QUESTIONS].map(key => `${key}_${user}`);

let jobsTimer: ReturnType<typeof setTimeout> | undefined;
let questionsTimer: ReturnType<typeof setTimeout> | undefined;

export function saveJobsCache(
  user: string,
  jobs: RemoteJob[],
  statuses: Record<string, JobStatus>,
) {
  if (jobsTimer) clearTimeout(jobsTimer);
  const [jobsKey, statusesKey] = keys(user);
  jobsTimer = setTimeout(() => {
    AsyncStorage.multiSet([
      [jobsKey, JSON.stringify(jobs)],
      [statusesKey, JSON.stringify(statuses)],
    ]).catch((e) => console.log("[cache] failed to save jobs:", e));
  }, 500);
}

export function saveQuestionsCache(user: string, questions: ClaudeQuestion[]) {
  if (questionsTimer) clearTimeout(questionsTimer);
  const [, , questionsKey] = keys(user);
  questionsTimer = setTimeout(() => {
    AsyncStorage.setItem(questionsKey, JSON.stringify(questions)).catch((e) =>
      console.log("[cache] failed to save questions:", e),
    );
  }, 500);
}

export async function loadCache(user: string): Promise<{
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  questions: ClaudeQuestion[];
} | null> {
  try {
    const results = await AsyncStorage.multiGet(keys(user));
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

export async function clearCache(user?: string | null) {
  if (jobsTimer) clearTimeout(jobsTimer);
  if (questionsTimer) clearTimeout(questionsTimer);
  jobsTimer = undefined;
  questionsTimer = undefined;
  try {
    await AsyncStorage.multiRemove([KEY_JOBS, KEY_STATUSES, KEY_QUESTIONS, ...(user ? keys(user) : [])]);
  } catch (e) {
    console.log("[cache] failed to clear:", e);
  }
}
