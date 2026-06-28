import { Platform } from "react-native";

const webColor = (token: string, fallback: string) => (
  Platform.OS === "web" ? `var(${token}, ${fallback})` : fallback
);

export const colors = {
  bg: webColor("--bg-primary", "#0a0a0a"),
  surface: webColor("--bg-secondary", "#161616"),
  surfaceHover: webColor("--hover-bg", "#1c1c1c"),
  border: webColor("--border-color", "#2a2a2a"),
  borderLight: webColor("--border-light", "#333"),

  text: webColor("--text-primary", "#e4e4e4"),
  textSecondary: webColor("--text-secondary", "#98989d"),
  textMuted: webColor("--text-muted", "#555"),

  accent: "#7986cb",
  accentDim: "#5c6bc0",
  accentBg: "rgba(121, 134, 203, 0.1)",

  success: "#32d74b",
  successBg: "rgba(50, 215, 75, 0.15)",
  warning: "#ff9f0a",
  warningBg: "rgba(255, 159, 10, 0.15)",
  danger: "#ff453a",
  dangerBg: "rgba(255, 69, 58, 0.15)",

  statusIdle: "#98989d",
  statusRunning: "#7986cb",
  statusSuccess: "#32d74b",
  statusFailed: "#ff453a",
  statusPaused: "#ff9f0a",
} as const;
