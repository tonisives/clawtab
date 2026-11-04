import { useMemo } from "react";
import { WebView } from "react-native-webview";
import { clawArrivalDocument } from "../lib/clawArrivalDocument";

export type ClawMarkProps = { playing?: boolean; settled?: boolean; onComplete?: () => void; onReady?: () => void };

export function ClawMark({ playing = false, settled = false, onComplete, onReady }: ClawMarkProps) {
  const source = useMemo(() => ({ html: clawArrivalDocument(playing, settled) }), [playing, settled]);
  return <WebView
    source={source}
    style={{ flex: 1, backgroundColor: "transparent" }}
    onLoadEnd={onReady}
    scrollEnabled={false}
    originWhitelist={["about:*"]}
    onMessage={({ nativeEvent }) => {
      if (nativeEvent.data === '{"clawArrival":"complete"}') onComplete?.();
    }}
    accessible={false}
    pointerEvents="none"
  />;
}
