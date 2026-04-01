import { useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import { View, StyleSheet } from "react-native";

export interface XtermLogHandle {
  /** Write base64-encoded terminal data */
  write(b64: string): void;
  /** Write plain text (normalises \n to \r\n for xterm) */
  writeText(text: string): void;
  /** Reset terminal state */
  clear(): void;
  /** Get current terminal dimensions */
  dimensions(): { cols: number; rows: number };
}

interface XtermLogProps {
  /** Called when user types (base64-encoded) */
  onData?: (b64: string) => void;
  /** Called when terminal resizes */
  onResize?: (cols: number, rows: number) => void;
  /** Whether terminal accepts input (default true) */
  interactive?: boolean;
}

// Minimal HTML page that bundles xterm.js via CDN
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.min.js"></script>
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1c1c1e}
#terminal{height:100%;width:100%}
</style>
</head>
<body>
<div id="terminal"></div>
<script>
var term = new Terminal({
  fontSize: 12,
  fontFamily: 'monospace',
  theme: {
    background:'#1c1c1e',foreground:'#e4e4e4',cursor:'#7986cb',
    cursorAccent:'#0a0a0a',selectionBackground:'rgba(121,134,203,0.3)',
    selectionForeground:'#e4e4e4',black:'#161616',red:'#ff453a',
    green:'#32d74b',yellow:'#ff9f0a',blue:'#7986cb',magenta:'#da77f2',
    cyan:'#66d9e8',white:'#e4e4e4',brightBlack:'#555',brightRed:'#ff6b6b',
    brightGreen:'#51cf66',brightYellow:'#ffd43b',brightBlue:'#91d5ff',
    brightMagenta:'#e599f7',brightCyan:'#99e9f2',brightWhite:'#ffffff'
  },
  allowProposedApi: true,
  scrollback: 10000,
  disableStdin: false
});
var fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

term.onData(function(data) {
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:btoa(data)}));
});

var ro = new ResizeObserver(function() {
  fit.fit();
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
});
ro.observe(document.getElementById('terminal'));

window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
</script>
</body>
</html>`;

/**
 * Native xterm.js renderer using WebView.
 * Requires react-native-webview in the consuming app.
 */
export const XtermLog = forwardRef<XtermLogHandle, XtermLogProps>(
  function XtermLog({ onData, onResize, interactive = true }, ref) {
    const webViewRef = useRef<any>(null);
    const dimsRef = useRef({ cols: 80, rows: 24 });

    useImperativeHandle(ref, () => ({
      write(b64: string) {
        // Escape the base64 string for injection
        const escaped = b64.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        webViewRef.current?.injectJavaScript(
          `(function(){var b='${escaped}';var a=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});term.write(a)})();true;`
        );
      },
      writeText(text: string) {
        const normalised = text.replace(/\r?\n/g, "\r\n");
        const escaped = normalised.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        webViewRef.current?.injectJavaScript(`term.write('${escaped}');true;`);
      },
      clear() {
        webViewRef.current?.injectJavaScript(`term.reset();true;`);
      },
      dimensions() {
        return dimsRef.current;
      },
    }));

    const handleMessage = useCallback(
      (event: any) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data);
          if (msg.type === "data" && interactive) {
            onData?.(msg.data);
          } else if (msg.type === "resize") {
            dimsRef.current = { cols: msg.cols, rows: msg.rows };
            onResize?.(msg.cols, msg.rows);
          }
        } catch {
          // ignore parse errors
        }
      },
      [onData, onResize, interactive],
    );

    // Dynamic import of WebView - it's a peer dependency
    let WebView: any;
    try {
      WebView = require("react-native-webview").default;
    } catch {
      // If react-native-webview is not installed, show nothing
      return <View style={styles.container} />;
    }

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ html: XTERM_HTML }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: "#1c1c1e",
  },
  webview: {
    flex: 1,
    backgroundColor: "#1c1c1e",
  },
});
