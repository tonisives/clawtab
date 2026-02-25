import { useWindowDimensions } from "react-native";

const BREAKPOINT_MD = 768;
const BREAKPOINT_LG = 1024;

export function useResponsive() {
  const { width } = useWindowDimensions();
  return {
    width,
    isWide: width >= BREAKPOINT_MD,
    isDesktop: width >= BREAKPOINT_LG,
  };
}

export const CONTENT_MAX_WIDTH = 640;
export const WIDE_CONTENT_MAX_WIDTH = 960;
