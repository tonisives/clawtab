import { useCallback, useEffect, useRef } from "react";
import WebView from "react-native-webview";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMessageKeyboard } from "../hooks/useMessageKeyboard";
import document from "../lib/messageSurfaceDocument.generated";
import { messageSurfaceInitialDocument } from "../lib/messageSurfaceBootstrap";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";

export function MessageSurface(props: MessageSurfaceProps) {
  const source = useRef<{ html: string } | null>(null);
  if (!source.current) source.current = { html: messageSurfaceInitialDocument(document, props) };
  const view = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const keyboard = useMessageKeyboard();
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  const applyInsets = useCallback(() => {
    view.current?.injectJavaScript(`window.nfnMobile?.setInsets(${props.popup ? 0 : insets.bottom},${keyboard.overlap > 0});true;`);
  }, [insets.bottom, props.popup, keyboard.overlap]);
  useEffect(applyInsets, [applyInsets]);
  const send = useCallback((value: unknown) => {
    const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    view.current?.injectJavaScript(`window.nfn?.receive(${json});true;`);
  }, []);
  const synchronize = useCallback(() => {
    if (!ready.current) return;
    if (latest.current.active === false) {
      if (selected.current !== "inactive") send({ type: "hide" });
      selected.current = "inactive";
      return;
    }
    send(latest.current.snapshot);
    const selection = latest.current.selection ?? null;
    if (selection && selected.current !== selection) {
      send({ type: "open_record", id: selection, popup: latest.current.popup }); selected.current = selection;
    } else if (!selection && selected.current !== "") {
      send({ type: "show" }); selected.current = "";
    }
  }, [send]);
  useEffect(synchronize, [props.snapshot, props.selection, props.active, synchronize]);

  const receive = async (raw: string) => {
    let value: SurfaceMessage;
    try { value = JSON.parse(raw).nfn; } catch { return; }
    if (!value) return;
    if (value.preview_ready) { ready.current = true; selected.current = null; synchronize(); applyInsets(); }
    if (value.native) latest.current.onNative?.(value);
    if (!value.command || !value.token) return;
    try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
    catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
  };

  return <View ref={keyboard.host} onLayout={keyboard.onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: "#161616", paddingBottom: keyboard.overlap }}>
    <WebView ref={view} source={source.current} style={{ flex: 1, backgroundColor: "#161616" }}
    javaScriptEnabled originWhitelist={["*"]} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
    keyboardDisplayRequiresUserAction={false} hideKeyboardAccessoryView
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" bounces={false}
    onMessage={event => { void receive(event.nativeEvent.data); }}
    onShouldStartLoadWithRequest={request => request.url === "about:blank"}
    onLoadStart={() => { ready.current = false; }} />
  </View>;
}
