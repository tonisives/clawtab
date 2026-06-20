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
  /** Visually offset terminal contents without resizing the WebView */
  setVisualOffset(px: number): void;
  /** Blur the terminal input so native keyboards close */
  blur(): void;
  /** Focus the terminal input */
  focus(): void;
  /** Focuses the hidden paste target so iOS can show paste actions */
  showPasteMenu(): void;
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

function shouldForwardInput(data) {
  return !(/^\\x1b\\[(?:\\?|>|=)?[0-9;]*[cRn]$/.test(data));
}

term.onData(function(data) {
  if (!shouldForwardInput(data)) return;
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:btoa(data)}));
});

var pasteTarget = document.createElement('textarea');
pasteTarget.setAttribute('aria-hidden', 'true');
pasteTarget.autocapitalize = 'none';
pasteTarget.autocomplete = 'off';
pasteTarget.autocorrect = 'off';
pasteTarget.spellcheck = false;
pasteTarget.style.position = 'fixed';
pasteTarget.style.width = '2px';
pasteTarget.style.height = '2px';
pasteTarget.style.opacity = '0.01';
pasteTarget.style.left = '-20px';
pasteTarget.style.top = '-20px';
document.body.appendChild(pasteTarget);

pasteTarget.addEventListener('paste', function(e) {
  var text = '';
  try { text = e.clipboardData.getData('text/plain') || ''; } catch (err) {}
  if (!text) return;
  e.preventDefault();
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:btoa(text)}));
  pasteTarget.value = '';
  try { term.focus(); } catch (err) {}
});

function showPasteTarget(x, y) {
  pasteTarget.style.left = Math.max(0, Math.round(x || 0)) + 'px';
  pasteTarget.style.top = Math.max(0, Math.round(y || 0)) + 'px';
  pasteTarget.value = '';
  pasteTarget.focus();
  pasteTarget.select();
}

window.showPasteMenu = function() {
  var rect = document.getElementById('terminal').getBoundingClientRect();
  showPasteTarget(rect.left + 24, rect.top + 24);
};

var longPressTimer = null;
document.getElementById('terminal').addEventListener('touchstart', function(e) {
  if (longPressTimer) clearTimeout(longPressTimer);
  var touch = e.touches && e.touches[0];
  longPressTimer = setTimeout(function() {
    if (touch) showPasteTarget(touch.clientX, touch.clientY);
  }, 450);
}, { passive: true });
document.getElementById('terminal').addEventListener('touchmove', function() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
}, { passive: true });
document.getElementById('terminal').addEventListener('touchend', function() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
}, { passive: true });
document.getElementById('terminal').addEventListener('dblclick', function(e) {
  showPasteTarget(e.clientX, e.clientY);
});

var ro = new ResizeObserver(function() {
  fit.fit();
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
});
ro.observe(document.getElementById('terminal'));

window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
var visualOffsetMax = 0;
window.applyVisualOffset = function() {
  var el = document.getElementById('terminal');
  if (!el) return;
  var maxPx = Math.max(0, Math.round(visualOffsetMax || 0));
  var rows = term.rows || 1;
  var rowHeight = el.clientHeight / rows;
  var lastContentY = -1;
  try {
    var buffer = term.buffer && term.buffer.active;
    if (buffer) {
      for (var y = rows - 1; y >= 0; y--) {
        var line = buffer.getLine(buffer.viewportY + y);
        if (line && line.translateToString(true).trim().length > 0) {
          lastContentY = y;
          break;
        }
      }
    }
  } catch (e) {}
  if (lastContentY < 0) lastContentY = 0;
  var contentBottom = (lastContentY + 1) * rowHeight;
  var visibleHeight = Math.max(0, el.clientHeight - maxPx);
  var offset = Math.max(0, Math.min(maxPx, Math.ceil(contentBottom - visibleHeight)));
  el.style.transform = offset ? 'translate3d(0,' + (-offset) + 'px,0)' : '';
  el.style.transition = 'transform 180ms ease-out';
};
window.setVisualOffset = function(px) {
  visualOffsetMax = px || 0;
  window.applyVisualOffset();
};
window.blurTerminal = function() {
  try { term.blur(); } catch (e) {}
  try {
    var active = document.activeElement;
    if (active && active.blur) active.blur();
  } catch (e) {}
};
window.focusTerminal = function() {
  try { term.focus(); } catch (e) {}
};
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
    const readyRef = useRef(false);
    const pendingWritesRef = useRef<string[]>([]);

    const injectWrite = useCallback((b64: string) => {
      const escaped = b64.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      webViewRef.current?.injectJavaScript(
        `(function(){var b='${escaped}';var a=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});term.write(a,function(){window.applyVisualOffset&&window.applyVisualOffset()})})();true;`
      );
    }, []);

    const flushPendingWrites = useCallback(() => {
      if (!readyRef.current || pendingWritesRef.current.length === 0) return;
      for (const b64 of pendingWritesRef.current) injectWrite(b64);
      pendingWritesRef.current = [];
    }, [injectWrite]);

    useImperativeHandle(ref, () => ({
      write(b64: string) {
        if (!readyRef.current) {
          pendingWritesRef.current.push(b64);
          return;
        }
        injectWrite(b64);
      },
      writeText(text: string) {
        const normalised = text.replace(/\r?\n/g, "\r\n");
        const escaped = normalised.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        webViewRef.current?.injectJavaScript(`term.write('${escaped}',function(){window.applyVisualOffset&&window.applyVisualOffset()});true;`);
      },
      clear() {
        webViewRef.current?.injectJavaScript(`term.reset();true;`);
      },
      dimensions() {
        return dimsRef.current;
      },
      setVisualOffset(px: number) {
        const value = Math.max(0, Math.round(px));
        webViewRef.current?.injectJavaScript(`window.setVisualOffset && window.setVisualOffset(${value});true;`);
      },
      blur() {
        webViewRef.current?.injectJavaScript(`window.blurTerminal && window.blurTerminal();true;`);
      },
      focus() {
        webViewRef.current?.injectJavaScript(`window.focusTerminal && window.focusTerminal();true;`);
      },
      showPasteMenu() {
        webViewRef.current?.injectJavaScript(`window.showPasteMenu && window.showPasteMenu();true;`);
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
          } else if (msg.type === "ready") {
            readyRef.current = true;
            flushPendingWrites();
          }
        } catch {
          // ignore parse errors
        }
      },
      [onData, onResize, interactive, flushPendingWrites],
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
          hideKeyboardAccessoryView
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
