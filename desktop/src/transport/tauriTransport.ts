import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Transport } from "@clawtab/shared";
import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "@clawtab/shared";
import type { ClaudeProcess } from "@clawtab/shared";

export function createTauriTransport(): Transport {
  return {
    async listJobs() {
      const jobs = await invoke<RemoteJob[]>("get_jobs");
      const statuses = await invoke<Record<string, JobStatus>>("get_job_statuses");
      return { jobs, statuses };
    },

    async getStatuses() {
      return invoke<Record<string, JobStatus>>("get_job_statuses");
    },

    async runJob(name: string, params?: Record<string, string>) {
      return await invoke<{ pane_id: string; tmux_session: string } | null>("run_job_now", { name, params });
    },

    async stopJob(name: string) {
      await invoke("stop_job", { name });
    },

    async pauseJob(name: string) {
      await invoke("pause_job", { name });
    },

    async resumeJob(name: string) {
      await invoke("resume_job", { name });
    },

    async toggleJob(name: string) {
      await invoke("toggle_job", { name });
    },

    async deleteJob(name: string) {
      await invoke("delete_job", { name });
    },

    async getRunHistory(name: string) {
      return invoke<RunRecord[]>("get_job_runs", { jobName: name });
    },

    async getRunDetail(runId: string) {
      // Desktop runs have stdout/stderr inline in RunRecord
      // But we can still try to fetch from the run detail if available
      try {
        return await invoke<RunDetail>("get_run_detail", { runId });
      } catch {
        return null;
      }
    },

    async detectProcesses() {
      return invoke<ClaudeProcess[]>("detect_claude_processes");
    },

    async sendInput(name: string, text: string, freetext?: string) {
      await invoke("send_job_input", { name, text, freetext: freetext ?? null });
    },

    subscribeLogs(name: string, onChunk: (content: string) => void) {
      let active = true;
      let lastContent = "";

      const poll = async () => {
        try {
          const result = await invoke<string>("get_running_job_logs", { name });
          if (active && result !== lastContent) {
            lastContent = result;
            // Send full snapshot as replacement (prefix with \x00 to signal replace)
            onChunk("\x00" + result);
          }
        } catch {
          // Job may have stopped
        }
      };

      poll();
      const interval = setInterval(poll, 3000);

      // Also listen for tauri events for faster updates
      const unlistenPromise = listen<{ name: string; content: string }>("log-chunk", (event) => {
        if (active && event.payload.name === name) {
          // Trigger an immediate poll to get the full consistent state
          poll();
        }
      });

      return () => {
        active = false;
        clearInterval(interval);
        unlistenPromise.then((fn) => fn());
      };
    },

    async runAgent(prompt: string, workDir?: string) {
      return await invoke<{ pane_id: string; tmux_session: string } | null>("run_agent", { prompt, workDir });
    },

    async focusJobWindow(name: string) {
      await invoke("focus_job_window", { name });
    },

    async saveJob(job: RemoteJob) {
      await invoke("save_job", { job });
    },

    async restartJob(name: string, params?: Record<string, string>) {
      await invoke("restart_job", { name, params });
    },

    async sigintJob(name: string) {
      await invoke("sigint_job", { name });
    },
  };
}
