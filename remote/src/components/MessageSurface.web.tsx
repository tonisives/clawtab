import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalKeyboardToolbar } from "./TerminalKeyboardToolbar";
import { TerminalWriteDialog } from "./TerminalWriteDialog";
import { observeMessageKeyboard } from "../lib/messageKeyboardViewport";
import document from "../lib/messageSurfaceDocument.generated";
import { messageSurfaceDefaultView, messageSurfaceInitialDocument } from "../lib/messageSurfaceBootstrap";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";

export function MessageSurface(props: MessageSurfaceProps) {
  const [desktopKeyboard, setDesktopKeyboard] = useState(() => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const change = () => setDesktopKeyboard(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
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
  const host = useRef<HTMLDivElement>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const menuOpenRef = useRef(false);
  const writeOpenRef = useRef(writeOpen);
  writeOpenRef.current = writeOpen;
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  const send = useCallback((value: unknown) => frame.current?.contentWindow?.postMessage(value, "*"), []);
  useEffect(() => observeMessageKeyboard(window,
    () => latest.current.snapshot.shell_only ? host.current : frame.current,
    (visible, dismissed) => {
      setKeyboardVisible(visible);
      if (dismissed) {
        if (latest.current.snapshot.shell_only && !menuOpenRef.current && !writeOpenRef.current && !desktopKeyboard) {
          setReply(false);
          send({ type: "mobile_action", action: "reply_close" });
        }
      }
    }), [desktopKeyboard, send]);
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
      if (desktopKeyboard && latest.current.snapshot.shell_only) send({ type: "mobile_action", action: "reply" });
    } else if (!selection && selected.current !== defaultView) {
      send({ type: defaultView });
      selected.current = defaultView;
    }
  }, [send, desktopKeyboard]);

  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.nfn) return;
      const value = event.data.nfn as SurfaceMessage;
      if (value.native === "chrome") setReply(Boolean((value as SurfaceMessage & { reply?: boolean }).reply));
      if (value.native === "external_link" && typeof value.text === "string" && /^(https?:\/\/|mailto:)/i.test(value.text)) window.open(value.text, "_blank", "noopener,noreferrer");
      if (value.native === "copy_text" && typeof value.text === "string") {
        try { await navigator.clipboard.writeText(value.text); send({ type: "copy_result", token: value.token }); }
        catch { send({ type: "copy_result", token: value.token, error: "Could not copy reply" }); }
      }
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
  const changeMenu = (open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
    if (!open && !keyboardVisible) {
      setReply(false);
      send({ type: "mobile_action", action: "reply_close" });
    }
  };
  const input = (text: string) => send({ type: "mobile_action", action: "shell_input", text });
  return <div ref={host} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
    {iframe}
    {((reply && keyboardVisible) || menuOpen) && !desktopKeyboard && !writeOpen && props.active !== false ? <div
      style={{ flexShrink: 0 }}
      // Keep taps on terminal actions from moving focus out of the iframe input.
      onPointerDown={event => event.preventDefault()}>
      <TerminalKeyboardToolbar bottom={0} inline dismissIcon="close"
      onDismiss={() => { setReply(false); menuOpenRef.current = false; setMenuOpen(false); send({ type: "mobile_action", action: "reply_close" }); }} onSend={input}
      onWrite={() => { menuOpenRef.current = false; setMenuOpen(false); setWriteOpen(true); }} menuOpen={menuOpen} onMenuOpenChange={changeMenu} />
    </div> : null}
    <TerminalWriteDialog visible={writeOpen} draft={draft} onDraftChange={setDraft} onClose={() => setWriteOpen(false)} onDone={() => {
      const text = draft.replace(/\r\n|\n/g, "\r"); input(text.endsWith("\r") ? text : text + "\r");
      setDraft(""); setWriteOpen(false);
    }} />
  </div>;
}
