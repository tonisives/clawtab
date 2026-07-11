import { Dimensions, Platform, useWindowDimensions } from "react-native";

const BREAKPOINT_MD = 768;
const BREAKPOINT_LG = 1024;

export function useResponsive() {
  const windowDimensions = useWindowDimensions();
  const fallbackWidth = Dimensions.get("window").width;
  const fallbackHeight = Dimensions.get("window").height;
  const width = windowDimensions.width || fallbackWidth;
  const height = windowDimensions.height || fallbackHeight;
  const isIosPad = Platform.OS === "ios" && Platform.isPad === true;
  const isIosPadLandscape = isIosPad && width > height && width >= 700;

  return {
    width,
    isIosPad,
    isIosPadPortrait: isIosPad && !isIosPadLandscape,
    // Keep the wide desktop shell off iOS; iPad portrait and landscape use
    // the liquid section control with different content arrangements.
    isWide: Platform.OS !== "ios" && width >= BREAKPOINT_MD,
    // Content can still take advantage of an iPad's horizontal space without
    // forcing the portrait layout into a split pane.
    isSplitView: Platform.OS === "ios" ? isIosPadLandscape : width >= BREAKPOINT_MD,
    isDesktop: width >= BREAKPOINT_LG,
  };
}

export const CONTENT_MAX_WIDTH = 640;
export const WIDE_CONTENT_MAX_WIDTH = 960;
