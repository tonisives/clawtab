import { Platform, StyleSheet, View, Image } from "react-native";
import type { RemoteJob } from "../types/job";
import type { ClaudeProcess } from "../types/process";
import { colors } from "../theme/colors";
import { radius } from "../theme/spacing";
import claudeIcon from "../assets/claude-icon.png";
import cronIcon from "../assets/cron-icon.png";
import manualIcon from "../assets/manual-icon.png";
import shellIcon from "../assets/shell-icon.png";
import codexIcon from "../assets/codex-icon.png";

export type JobKind = "cron" | "manual" | "claude" | "codex" | "shell";

export function kindForJob(job: RemoteJob): JobKind {
  if (job.job_type === "claude") return "claude";
  if (job.job_type === "shell") return "shell";
  return job.cron ? "cron" : "manual";
}

export function kindForProcess(process: ClaudeProcess): JobKind {
  return process.process_type === "codex" ? "codex" : "claude";
}

export function kindForShell(): JobKind {
  return "shell";
}

function paletteForKind(kind: JobKind) {
  switch (kind) {
    case "claude":
      return { bg: colors.accentBg, fg: colors.accent };
    case "codex":
      return { bg: "rgba(83, 156, 255, 0.14)", fg: "#68a0ff" };
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
  const palette = paletteForKind(kind);
  const isClaude = kind === "claude";
  const imageSize = isClaude
    ? size
    : compact ? Math.round(size * 0.62) : Math.round(size * 0.66);
  const asset = sourceForKind(kind);
  const source = Platform.OS === "web" ? { uri: asset } : (asset as any);

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
              backgroundColor: isClaude ? "transparent" : palette.bg,
            },
      ]}
    >
      <Image
        source={source}
        style={{
          width: imageSize,
          height: imageSize,
          borderRadius: isClaude ? radius.sm : 0,
        }}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
});
