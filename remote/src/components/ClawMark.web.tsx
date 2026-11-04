import { useEffect, useMemo, useRef } from "react";
import { clawArrivalDocument } from "../lib/clawArrivalDocument";
import type { ClawMarkProps } from "./ClawMark";

export function ClawMark({ playing = false, settled = false, onComplete, onReady }: ClawMarkProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const document = useMemo(() => clawArrivalDocument(playing, settled), [playing, settled]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === ref.current?.contentWindow && event.data === '{"clawArrival":"complete"}') onComplete?.();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onComplete]);
  return <iframe ref={ref} srcDoc={document} onLoad={onReady} title="ClawTab" tabIndex={-1} aria-hidden
    sandbox="allow-scripts" style={{ width: "100%", height: "100%", border: 0, pointerEvents: "none" }} />;
}
