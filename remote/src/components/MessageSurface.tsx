import { useIsFocused } from "expo-router/react-navigation";
import { MessageTextSelection } from "./MessageTextSelection";
import { messageSelectionScript } from "../lib/messageSelection";
import { NotificationChrome, initialNotificationChrome, type NotificationChromeState } from "./NotificationChrome";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import WebView from "react-native-webview";
import { Keyboard, Linking, Platform, View } from "react-native";
import { ShellKeyboardInput } from "./ShellKeyboardInput";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMessageKeyboard } from "../hooks/useMessageKeyboard";
import document from "../lib/messageSurfaceDocument.generated";
import { messageSurfaceDefaultView, messageSurfaceInitialDocument } from "../lib/messageSurfaceBootstrap";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";
import { TerminalKeyboardToolbar } from "./TerminalKeyboardToolbar";
import { TerminalWriteDialog } from "./TerminalWriteDialog";

const nativeShellKeyboard = Platform.OS === "ios";

export function MessageSurface(props: MessageSurfaceProps) {
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | undefined>();
  const selectingText = useRef(false);
  const selectionGesture = useRef(false);
  const [selectionLayout, setSelectionLayout] = useState<{ paddingBottom: number; paddingLeft: number; paddingRight: number } | null>(null);
  const [chrome, setChrome] = useState(initialNotificationChrome);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeDraft, setWriteDraft] = useState("");
  const source = useRef<{ document: string; value: { html: string } } | null>(null);
  if (!source.current || source.current.document !== document) source.current = { document, value: { html: messageSurfaceInitialDocument(document, { ...props, snapshot: { ...props.snapshot, native_keyboard: nativeShellKeyboard, native_selection: nativeShellKeyboard } }) } };
  const view = useRef<WebView<object>>(null);
  const shellKeyboard = useRef<ComponentRef<typeof ShellKeyboardInput>>(null);
  const insets = useSafeAreaInsets();
  const keyboard = useMessageKeyboard(!props.popup);
  const contentLayout = selectionLayout ?? {
    paddingBottom: chrome.reply && selectionText === null ? Math.max(keyboard.overlap, insets.bottom) : keyboard.overlap,
    paddingLeft: keyboard.horizontalInsets.left, paddingRight: keyboard.horizontalInsets.right,
  };
  const layoutRef = useRef(contentLayout);
  layoutRef.current = contentLayout;
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  const footerOwnsSafeArea = !props.popup && !props.snapshot.shell_only && !props.snapshot.demo && chrome.screen === "message" && !chrome.reply;
  const applyInsets = useCallback(() => {
    view.current?.injectJavaScript(`window.nfnMobile?.setInsets(${props.popup || footerOwnsSafeArea ? 0 : insets.bottom},${keyboard.overlap > 0});true;`);
  }, [insets.bottom, props.popup, keyboard.overlap, footerOwnsSafeArea]);
  useEffect(applyInsets, [applyInsets]);
  const send = useCallback((value: unknown) => {
    const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    view.current?.injectJavaScript(`window.nfn?.receive(${json});true;`);
  }, []);
  useEffect(() => {
    if (ready.current) send({ type: "mobile_visibility", active: focused });
  }, [focused, send]);
  const action = useCallback((action: string) => {
    if (action === "reply_focus" && (selectingText.current || selectionGesture.current || !focusedRef.current)) return;
    if (action === "reply_focus" && nativeShellKeyboard) { shellKeyboard.current?.focus(); return; }
    if (action === "select_text") {
      setTerminalMenuOpen(false); setWriteOpen(false);
      selectingText.current = true;
      shellKeyboard.current?.blur();
      view.current?.injectJavaScript(messageSelectionScript);
      Keyboard.dismiss();
      return;
    }
    selectingText.current = false; setSelectionText(null);
    send({ type: "mobile_action", action });
  }, [send]);
  useEffect(() => {
    selectingText.current = false; setSelectionText(null);
    selectionGesture.current = false; setSelectionLayout(null);
    shellKeyboard.current?.blur();
  }, [props.selection, props.active, focused]);
  const sendTerminalText = useCallback((text: string) => send({ type: "mobile_action", action: "shell_input", text }), [send]);
  useEffect(() => {
    if (!chrome.reply) { setTerminalMenuOpen(false); setWriteOpen(false); return; }
    if (focused && !writeOpen && selectionText === null && !selectingText.current) {
      const timer = setTimeout(() => action("reply_focus"), 350);
      return () => clearTimeout(timer);
    }
  }, [action, chrome.reply, writeOpen, selectionText, focused]);
  const synchronize = useCallback(() => {
    if (!ready.current || !focusedRef.current) return;
    if (latest.current.active === false) {
      if (selected.current !== "inactive") send({ type: "hide" });
      selected.current = "inactive";
      return;
    }
    if (selectingText.current || selectionGesture.current) return;
    send({ ...latest.current.snapshot, native_keyboard: nativeShellKeyboard, native_selection: nativeShellKeyboard });
    const selection = latest.current.selection ?? null;
    const defaultView = messageSurfaceDefaultView(latest.current.snapshot);
    if (selection && selected.current !== selection) {
      send({ type: "open_record", id: selection, popup: latest.current.popup }); selected.current = selection;
    } else if (!selection && selected.current !== defaultView) {
      send({ type: defaultView }); selected.current = defaultView;
    }
  }, [send]);
  useEffect(synchronize, [props.snapshot, props.selection, props.active, selectionText, selectionLayout, focused, synchronize]);

  const receive = async (raw: string) => {
    let value: SurfaceMessage;
    try { value = JSON.parse(raw).nfn; } catch { return; }
    if (!value) return;
    if (!latest.current.snapshot.demo && value.native === "external_link" && typeof value.text === "string" && /^(https?:\/\/|mailto:)/i.test(value.text)) void Linking.openURL(value.text);
    if (value.preview_ready) { ready.current = true; selected.current = null; send({ type: "mobile_visibility", active: focusedRef.current }); synchronize(); applyInsets(); }
    if (value.native === "selection_gesture" && (focusedRef.current || !value.active)) {
      selectionGesture.current = Boolean(value.active);
      setSelectionLayout(value.active ? layoutRef.current : null);
      if (value.active) shellKeyboard.current?.blur();
    }
    if (value.native === "shell_keyboard") {
      if (value.active && focusedRef.current && latest.current.active !== false && !selectingText.current && !selectionGesture.current) shellKeyboard.current?.focus();
      else if (!value.active) shellKeyboard.current?.blur();
    }
    if (value.native === "selection_text" && typeof value.text === "string"
      && focusedRef.current && latest.current.active !== false && (selectingText.current || value.gesture)) {
      selectingText.current = true;
      shellKeyboard.current?.blur(); Keyboard.dismiss();
      setSelectionRange(value.selection); setSelectionText(value.text);
    }
    if (value.native === "chrome" && !selectingText.current && !selectionGesture.current) setChrome(value as unknown as NotificationChromeState);
    if (value.native) latest.current.onNative?.(value);
    if (!value.command || !value.token) return;
    try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
    catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
  };

  return <View ref={keyboard.host} onLayout={keyboard.onLayout} pointerEvents={focused && props.active !== false ? "auto" : "none"}
    accessibilityElementsHidden={!focused || props.active === false}
    style={{ flex: 1, minHeight: 0, backgroundColor: "#161616", ...contentLayout }}>
    <WebView<object> ref={view} source={source.current.value} style={{ flex: 1, backgroundColor: "#161616" }}
    containerStyle={{ display: selectionText === null ? "flex" : "none" }}
    scrollEnabled={false} textInteractionEnabled dataDetectorTypes="none"
    javaScriptEnabled originWhitelist={["*"]} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
    keyboardDisplayRequiresUserAction={false} hideKeyboardAccessoryView
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" bounces={false}
    onMessage={event => { void receive(event.nativeEvent.data); }}
    onShouldStartLoadWithRequest={request => request.url === "about:blank"}
    onLoadStart={() => { ready.current = false; }} />
    {nativeShellKeyboard ? <ShellKeyboardInput ref={shellKeyboard} onSend={sendTerminalText} /> : null}
    {selectionText !== null ? <MessageTextSelection text={selectionText} selection={selectionRange} bottom={insets.bottom} onDone={() => {
      selectingText.current = false; setSelectionText(null);
    }} /> : null}
    {!props.popup && !props.snapshot.shell_only && props.active !== false && selectionText === null ? <NotificationChrome state={chrome} send={action} bottom={insets.bottom} demo={Boolean(props.snapshot.demo)} enabled /> : null}
    {chrome.reply && props.active !== false && selectionText === null ? <TerminalKeyboardToolbar
      bottom={0} inline
      dismissIcon="close"
      onDismiss={() => action("reply_close")}
      onSend={sendTerminalText}
      onSelect={() => action("select_text")}
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
