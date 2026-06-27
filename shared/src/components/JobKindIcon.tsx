import { useState } from "react";
import { StyleSheet, View, Image, Text } from "react-native";
import type { RemoteJob } from "../types/job";
import type { DetectedProcess, ProcessProvider } from "../types/process";
import { colors } from "../theme/colors";
import { radius } from "../theme/spacing";
import claudeIcon from "../assets/claude-icon.png";
import cronIcon from "../assets/cron-icon.png";
import manualIcon from "../assets/manual-icon.png";
import shellIcon from "../assets/shell-icon.png";
import codexIcon from "../assets/codex-icon.png";
import opencodeIcon from "../assets/opencode-icon.png";
import antigravityIcon from "../assets/antigravity-icon.png";

export type JobKind = "cron" | "manual" | "claude" | "codex" | "opencode" | "antigravity" | "shell";

export function kindForJob(job: RemoteJob): JobKind {
  if (job.agent_provider === "antigravity" || job.job_type === "antigravity") return "antigravity";
  if (job.agent_provider === "codex" || job.job_type === "codex") return "codex";
  if (job.agent_provider === "opencode" || job.job_type === "opencode") return "opencode";
  if (job.agent_provider === "shell") return "shell";
  if (job.job_type === "claude") return "claude";
  if (job.job_type === "shell") return "shell";
  if (job.agent_provider === "claude") return "claude";
  return job.cron ? "cron" : "manual";
}

export function providerKindForJob(job: RemoteJob): ProcessProvider | null {
  if (
    job.agent_provider === "claude" ||
    job.agent_provider === "codex" ||
    job.agent_provider === "opencode" ||
    job.agent_provider === "antigravity" ||
    job.agent_provider === "shell"
  ) {
    return job.agent_provider;
  }
  if (job.job_type === "claude") return "claude";
  if (job.job_type === "codex") return "codex";
  if (job.job_type === "opencode") return "opencode";
  if (job.job_type === "antigravity") return "antigravity";
  if (job.job_type === "shell") return "shell";
  return null;
}

export function scheduledProviderKindForJob(job: RemoteJob, defaultAgentProvider?: ProcessProvider): ProcessProvider | null {
  const explicitProvider = providerKindForJob(job);
  if (explicitProvider) return explicitProvider;
  if (job.job_type === "job") return defaultAgentProvider ?? null;
  return null;
}

export function kindForProcess(process: DetectedProcess): JobKind {
  switch (process.provider) {
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "antigravity":
      return "antigravity";
    default:
      return "claude";
  }
}

export function kindForShell(): JobKind {
  return "shell";
}

function paletteForKind(kind: JobKind) {
  switch (kind) {
    case "claude":
      return { bg: colors.accentBg, fg: colors.accent };
    case "codex":
      return { bg: "transparent", fg: colors.text };
    case "opencode":
      return { bg: "transparent", fg: colors.text };
    case "antigravity":
      return { bg: "transparent", fg: colors.text };
    case "shell":
      return { bg: colors.successBg ?? "rgba(52, 199, 89, 0.14)", fg: colors.success ?? "#34c759" };
    case "cron":
      return { bg: "rgba(255, 159, 10, 0.16)", fg: "#ff9f0a" };
    case "manual":
      return { bg: "rgba(10, 132, 255, 0.14)", fg: "#0a84ff" };
    default:
      return { bg: "rgba(152, 152, 157, 0.12)", fg: colors.textSecondary };
  }
}

function sourceForKind(kind: JobKind) {
  switch (kind) {
    case "claude":
      return claudeIcon;
    case "cron":
      return cronIcon;
    case "manual":
      return manualIcon;
    case "shell":
      return shellIcon;
    case "codex":
      return codexIcon;
    case "opencode":
      return opencodeIcon;
    case "antigravity":
      return antigravityIcon;
  }
}

function fallbackLabelForKind(kind: JobKind) {
  switch (kind) {
    case "claude":
      return "C";
    case "codex":
      return "CX";
    case "opencode":
      return "OC";
    case "antigravity":
      return "AG";
    case "shell":
      return "$";
    case "cron":
      return "CR";
    case "manual":
      return "M";
  }
}

export function JobKindIcon({
  kind,
  size = 32,
  compact = false,
  bare = false,
}: {
  kind: JobKind;
  size?: number;
  compact?: boolean;
  bare?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const palette = paletteForKind(kind);
  const hasIntrinsicBadge = kind === "claude" || kind === "codex" || kind === "opencode" || kind === "antigravity";
  const imageSize = hasIntrinsicBadge
    ? size
    : compact ? Math.round(size * 0.62) : Math.round(size * 0.66);
  const asset = sourceForKind(kind);
  const source = asset as any;

  return (
    <View
      style={[
        styles.wrap,
        bare
          ? { width: size, height: size }
          : {
              width: size,
              height: size,
              borderRadius: radius.sm,
              backgroundColor: hasIntrinsicBadge ? "transparent" : palette.bg,
            },
      ]}
    >
      {imageFailed ? (
        <Text
          style={[
            styles.fallbackText,
            {
              color: palette.fg,
              fontSize: Math.max(9, Math.round(size * (fallbackLabelForKind(kind).length > 1 ? 0.31 : 0.45))),
            },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {fallbackLabelForKind(kind)}
        </Text>
      ) : (
        <Image
          source={source}
          style={{
            width: imageSize,
            height: imageSize,
            borderRadius: hasIntrinsicBadge ? radius.sm : 0,
          }}
          resizeMode="contain"
          onError={() => setImageFailed(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  fallbackText: {
    fontWeight: "700",
    letterSpacing: 0,
    textAlign: "center",
  },
});
