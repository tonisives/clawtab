import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalKeyboardToolbar } from "./TerminalKeyboardToolbar";
import { TerminalWriteDialog } from "./TerminalWriteDialog";
import document from "../lib/messageSurfaceDocument.generated";
import { messageSurfaceDefaultView, messageSurfaceInitialDocument } from "../lib/messageSurfaceBootstrap";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";

export function MessageSurface(props: MessageSurfaceProps) {
  const source = useRef<string | null>(null);
  if (source.current === null) {
    source.current = messageSurfaceInitialDocument(document, props);
    if (props.snapshot.shell_only) source.current = source.current.replace("<script>",
      '<script>window.ReactNativeWebView={postMessage:raw=>window.parent.postMessage(JSON.parse(raw),"*")};');
  }
  const [reply, setReply] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [draft, setDraft] = useState("");
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
    if (latest.current.active === false) {
      if (selected.current !== "inactive") send({ type: "hide" });
      selected.current = "inactive";
      return;
    }
    send(latest.current.snapshot);
    const selection = latest.current.selection ?? null;
    const defaultView = messageSurfaceDefaultView(latest.current.snapshot);
    if (selection && selected.current !== selection) {
      send({ type: "open_record", id: selection, popup: latest.current.popup });
      selected.current = selection;
    } else if (!selection && selected.current !== defaultView) {
      send({ type: defaultView });
      selected.current = defaultView;
    }
  }, [send]);

  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.nfn) return;
      const value = event.data.nfn as SurfaceMessage;
      if (value.native === "chrome") setReply(Boolean((value as SurfaceMessage & { reply?: boolean }).reply));
      if (value.native === "external_link" && typeof value.text === "string" && /^(https?:\/\/|mailto:)/i.test(value.text)) window.open(value.text, "_blank", "noopener,noreferrer");
      if (value.preview_ready) { ready.current = true; selected.current = null; synchronize(); }
      if (value.native) latest.current.onNative?.(value);
      if (!value.command || !value.token) return;
      try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
      catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [send, synchronize]);
  useEffect(synchronize, [props.snapshot, props.selection, props.active, synchronize]);

  const iframe = <iframe ref={frame} title="Messages" sandbox="allow-scripts" srcDoc={source.current}
    style={{ display: "block", width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0, background: "#161616" }}
    onLoad={() => { ready.current = true; selected.current = null; synchronize(); }} />;
  if (!props.snapshot.shell_only) return iframe;
  const input = (text: string) => send({ type: "mobile_action", action: "shell_input", text });
  return <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
    {iframe}
    {reply ? <TerminalKeyboardToolbar bottom={0} inline dismissIcon="close"
      onDismiss={() => send({ type: "mobile_action", action: "reply_close" })} onSend={input}
      onWrite={() => { setMenuOpen(false); setWriteOpen(true); }} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen} /> : null}
    <TerminalWriteDialog visible={writeOpen} draft={draft} onDraftChange={setDraft} onClose={() => setWriteOpen(false)} onDone={() => {
      const text = draft.replace(/\r\n|\n/g, "\r"); input(text.endsWith("\r") ? text : text + "\r");
      setDraft(""); setWriteOpen(false);
    }} />
  </div>;
}
