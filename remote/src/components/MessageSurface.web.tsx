import { useCallback, useEffect, useRef } from "react";
import document from "../lib/messageSurfaceDocument.generated";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";

export function MessageSurface(props: MessageSurfaceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let pending = 0;
    const resize = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const element = frame.current;
        if (!element) return;
        // Route transitions move the frame without a viewport resize. Keep
        // natural flex sizing until the keyboard reduces the visible viewport.
        const bottom = viewport.offsetTop + viewport.height;
        element.style.maxHeight = window.innerHeight - viewport.height > 100
          ? `${Math.max(0, bottom - element.getBoundingClientRect().top)}px` : "";
      });
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(pending);
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  const send = useCallback((value: unknown) => frame.current?.contentWindow?.postMessage(value, "*"), []);
  const synchronize = useCallback(() => {
    if (!ready.current) return;
    send(latest.current.snapshot);
    const selection = latest.current.selection ?? null;
    if (selection && selected.current !== selection) {
      send({ type: "open_record", id: selection, popup: latest.current.popup });
      selected.current = selection;
    } else if (!selection && selected.current !== "") {
      send({ type: "show" });
      selected.current = "";
    }
  }, [send]);

  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.nfn) return;
      const value = event.data.nfn as SurfaceMessage;
      if (value.preview_ready) { ready.current = true; selected.current = null; synchronize(); }
      if (value.native) latest.current.onNative?.(value);
      if (!value.command || !value.token) return;
      try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
      catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [send, synchronize]);
  useEffect(synchronize, [props.snapshot, props.selection, synchronize]);

  return <iframe ref={frame} title="Messages" sandbox="allow-scripts" srcDoc={document}
    style={{ display: "block", width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0, background: "#161616" }}
    onLoad={() => { ready.current = true; selected.current = null; synchronize(); }} />;
}
