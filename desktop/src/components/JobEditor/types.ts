import type { Job, NotifyTarget } from "../../types";

export const DEFAULT_TEMPLATE = "# Job Directions\n\nDescribe what the bot should do here.\n";
export const DEFAULT_SHELL_TEMPLATE = "# Shell Command\n\nsh run.sh\n";

export const STEP_TIPS: Record<string, string> = {
  identity: "Choose the working directory, name the job, and write its directions.",
  settings: "Configure schedule, secrets, and notifications. Expand sections as needed.",
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DAY_CRON_MAP: Record<string, string> = {
  Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "0",
};
export const CRON_DAY_MAP: Record<string, string> = {
  "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat",
};

export type WizardStep = "identity" | "settings";

export const STEPS: { id: WizardStep; label: string }[] = [
  { id: "identity", label: "Identity & Directions" },
  { id: "settings", label: "Settings" },
];

export const JOB_NAME_MAX_LENGTH = 40;

export const emptyJob: Job = {
  name: "",
  job_type: "job",
  enabled: true,
  path: "",
  args: [],
  cron: "0 0 * * *",
  secret_keys: [],
  env: {},
  work_dir: null,
  tmux_session: "tgs",
  folder_path: null,
  job_id: null,
  telegram_chat_id: null,
  telegram_log_mode: "on_prompt",
  telegram_notify: { start: false, working: false, logs: false, finish: false },
  notify_target: "none",
  group: "dog-free",
  slug: "",
  skill_paths: [],
  params: [],
  kill_on_end: false,
  auto_yes: false,
  agent_provider: null,
  aerospace_workspace: null,
};

export interface JobEditorProps {
  job: Job | null;
  onSave: (job: Job) => void;
  onCancel: () => void;
  onPickTemplate?: (templateId: string) => void;
  defaultGroup?: string;
  defaultFolderPath?: string;
  headerMode?: "back" | "close";
}
