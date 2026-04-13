import type { PaneContent, ProcessProvider, DetectedProcess } from "@clawtab/shared";

export const SINGLE_PANE_CACHE_LIMIT = 10;

export function paneContentCacheKey(content: PaneContent): string {
  if (content.kind === "job") return content.slug;
  if (content.kind === "agent") return "_agent";
  if (content.kind === "terminal") return `_term_${content.paneId}`;
  return content.paneId;
}

export function shouldCacheSinglePaneContent(content: PaneContent): boolean {
  return content.kind === "job" || content.kind === "agent";
}

export function providerCapabilities(provider: ProcessProvider): Pick<DetectedProcess, "can_fork_session" | "can_send_skills" | "can_inject_secrets"> {
  if (provider === "claude") {
    return { can_fork_session: true, can_send_skills: true, can_inject_secrets: true };
  }
  return { can_fork_session: false, can_send_skills: false, can_inject_secrets: false };
}
