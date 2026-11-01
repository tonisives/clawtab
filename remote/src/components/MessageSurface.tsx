import { NotificationChrome, initialNotificationChrome, type NotificationChromeState } from "./NotificationChrome";
import { useCallback, useEffect, useRef, useState } from "react";
import WebView from "react-native-webview";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMessageKeyboard } from "../hooks/useMessageKeyboard";
import document from "../lib/messageSurfaceDocument.generated";
import { messageSurfaceDefaultView, messageSurfaceInitialDocument } from "../lib/messageSurfaceBootstrap";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";
import { TerminalKeyboardToolbar } from "./TerminalKeyboardToolbar";
import { TerminalWriteDialog } from "./TerminalWriteDialog";

export function MessageSurface(props: MessageSurfaceProps) {
  const [chrome, setChrome] = useState(initialNotificationChrome);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeDraft, setWriteDraft] = useState("");
  const source = useRef<{ document: string; value: { html: string } } | null>(null);
  if (!source.current || source.current.document !== document) source.current = { document, value: { html: messageSurfaceInitialDocument(document, props) } };
  const view = useRef<WebView<object>>(null);
  const insets = useSafeAreaInsets();
  const keyboard = useMessageKeyboard();
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  const applyInsets = useCallback(() => {
    view.current?.injectJavaScript(`window.nfnMobile?.setInsets(${props.popup || chrome.screen === "message" ? 0 : insets.bottom},${keyboard.overlap > 0});true;`);
  }, [insets.bottom, props.popup, keyboard.overlap, chrome.screen, chrome.reply]);
  useEffect(applyInsets, [applyInsets]);
  const send = useCallback((value: unknown) => {
    const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    view.current?.injectJavaScript(`window.nfn?.receive(${json});true;`);
  }, []);
  const action = useCallback((action: string) => send({ type: "mobile_action", action }), [send]);
  const sendTerminalText = useCallback((text: string) => send({ type: "mobile_action", action: "shell_input", text }), [send]);
  useEffect(() => {
    if (!chrome.reply) { setTerminalMenuOpen(false); setWriteOpen(false); return; }
    if (!writeOpen) {
      const timer = setTimeout(() => action("reply_focus"), 350);
      return () => clearTimeout(timer);
    }
  }, [action, chrome.reply, writeOpen]);
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
      send({ type: "open_record", id: selection, popup: latest.current.popup }); selected.current = selection;
    } else if (!selection && selected.current !== defaultView) {
      send({ type: defaultView }); selected.current = defaultView;
    }
  }, [send]);
  useEffect(synchronize, [props.snapshot, props.selection, props.active, synchronize]);

  const receive = async (raw: string) => {
    let value: SurfaceMessage;
    try { value = JSON.parse(raw).nfn; } catch { return; }
    if (!value) return;
    if (value.preview_ready) { ready.current = true; selected.current = null; synchronize(); applyInsets(); }
    if (value.native === "chrome") setChrome(value as unknown as NotificationChromeState);
    if (value.native) latest.current.onNative?.(value);
    if (!value.command || !value.token) return;
    try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
    catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
  };

  return <View ref={keyboard.host} onLayout={keyboard.onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: "#161616", paddingBottom: chrome.reply ? Math.max(keyboard.overlap, insets.bottom) : keyboard.overlap, paddingLeft: keyboard.horizontalInsets.left, paddingRight: keyboard.horizontalInsets.right }}>
    <WebView<object> ref={view} source={source.current.value} style={{ flex: 1, backgroundColor: "#161616" }}
    javaScriptEnabled originWhitelist={["*"]} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
    keyboardDisplayRequiresUserAction={false} hideKeyboardAccessoryView
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" bounces={false}
    onMessage={event => { void receive(event.nativeEvent.data); }}
    onShouldStartLoadWithRequest={request => request.url === "about:blank"}
    onLoadStart={() => { ready.current = false; }} />
    {!props.popup && props.active !== false ? <NotificationChrome state={chrome} send={action} bottom={insets.bottom} enabled /> : null}
    {chrome.reply && props.active !== false ? <TerminalKeyboardToolbar
      bottom={0} inline
      dismissIcon="close"
      onDismiss={() => action("reply_close")}
      onSend={sendTerminalText}
      onWrite={() => { setTerminalMenuOpen(false); setWriteOpen(true); }}
      menuOpen={terminalMenuOpen}
      onMenuOpenChange={setTerminalMenuOpen}
    /> : null}
    <TerminalWriteDialog visible={writeOpen} draft={writeDraft} onDraftChange={setWriteDraft}
      onClose={() => setWriteOpen(false)} onDone={() => {
        const text = writeDraft.replace(/\r\n|\n/g, "\r");
        sendTerminalText(text.endsWith("\r") ? text : text + "\r");
        setWriteDraft(""); setWriteOpen(false);
      }} />
  </View>;
}
