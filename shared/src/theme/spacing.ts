import { Platform } from "react-native";

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: Platform.OS === "ios" ? 12 : 6,
  md: Platform.OS === "ios" ? 20 : 10,
  lg: Platform.OS === "ios" ? 28 : 16,
} as const;
