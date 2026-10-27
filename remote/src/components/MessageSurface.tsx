import { useCallback, useEffect, useRef } from "react";
import WebView from "react-native-webview";
import document from "../lib/messageSurfaceDocument.generated";
import type { MessageSurfaceProps, SurfaceMessage } from "./messageSurfaceTypes";

const source = { html: document };

export function MessageSurface(props: MessageSurfaceProps) {
  const view = useRef<WebView>(null);
  const latest = useRef(props);
  latest.current = props;
  const ready = useRef(false);
  const selected = useRef<string | null>(null);
  const send = useCallback((value: unknown) => {
    const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    view.current?.injectJavaScript(`window.nfn?.receive(${json});true;`);
  }, []);
  const synchronize = useCallback(() => {
    if (!ready.current) return;
    send(latest.current.snapshot);
    const selection = latest.current.selection ?? null;
    if (selection && selected.current !== selection) {
      send({ type: "open_record", id: selection }); selected.current = selection;
    } else if (!selection && selected.current === null) {
      send({ type: "show" }); selected.current = "";
    }
  }, [send]);
  useEffect(synchronize, [props.snapshot, props.selection, synchronize]);

  const receive = async (raw: string) => {
    let value: SurfaceMessage;
    try { value = JSON.parse(raw).nfn; } catch { return; }
    if (!value) return;
    if (value.preview_ready) { ready.current = true; selected.current = null; synchronize(); }
    if (value.native) latest.current.onNative?.(value);
    if (!value.command || !value.token) return;
    try { send({ type: "response", token: value.token, value: await latest.current.onCommand(value.command) }); }
    catch (error) { send({ type: "response", token: value.token, error: error instanceof Error ? error.message : String(error) }); }
  };

  return <WebView ref={view} source={source} style={{ flex: 1, backgroundColor: "#161616" }}
    javaScriptEnabled originWhitelist={["*"]} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
    keyboardDisplayRequiresUserAction={false} automaticallyAdjustContentInsets={false}
    onMessage={event => { void receive(event.nativeEvent.data); }}
    onShouldStartLoadWithRequest={request => request.url === "about:blank"}
    onLoadStart={() => { ready.current = false; }} />;
}
