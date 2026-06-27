import { useRef, useImperativeHandle, forwardRef, useCallback, useState } from "react";
import { View, StyleSheet, TextInput, Platform, Pressable } from "react-native";

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

function encodeTerminalInput(text: string): string {
  if (typeof btoa === "function") return btoa(text);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i) & 0xff;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) & 0xff : 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += i + 1 < text.length ? chars[(triplet >> 6) & 63] : "=";
    output += i + 2 < text.length ? chars[triplet & 63] : "=";
  }
  return output;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
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

var nativeKeyboardMode = false;
var iosKeyboardContext = '';

function terminalInputTextarea() {
  return document.querySelector('.xterm-helper-textarea');
}

function configureIosKeyboardContext() {
  var textarea = terminalInputTextarea();
  if (!textarea) return;
  textarea.setAttribute('inputmode', 'text');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocapitalize', 'none');
  textarea.spellcheck = false;
}

function rememberIosKeyboardContext(data) {
  if (!data) return;
  if (data === '\\r' || data === '\\n' || data === '\\u0003' || data === '\\u001b') {
    iosKeyboardContext = '';
    return;
  }
  if (data === '\\b' || data === '\\u007f') {
    iosKeyboardContext = iosKeyboardContext.slice(0, -1);
    return;
  }
  if (data.length !== 1) return;
  var code = data.charCodeAt(0);
  if (code < 32 || code === 127) return;
  iosKeyboardContext = (iosKeyboardContext + data).slice(-8);
}

function shouldResumeIosTextKeyboard(data) {
  if (data !== ' ') return false;
  var previous = iosKeyboardContext.charAt(iosKeyboardContext.length - 1);
  return /[,.!?;:)]/.test(previous);
}

function resumeIosTextKeyboard() {
  var textarea = terminalInputTextarea();
  if (!textarea || document.activeElement !== textarea) return;
  try {
    textarea.blur();
    setTimeout(function() {
      configureIosKeyboardContext();
      try { term.focus(); } catch (e) {}
    }, 0);
  } catch (e) {}
}

configureIosKeyboardContext();
setTimeout(configureIosKeyboardContext, 0);

window.setNativeKeyboardMode = function(enabled) {
  nativeKeyboardMode = !!enabled;
  term.options.disableStdin = nativeKeyboardMode;
  if (nativeKeyboardMode) {
    try { term.blur(); } catch (e) {}
    try {
      var active = document.activeElement;
      if (active && active.blur) active.blur();
    } catch (e) {}
  }
};

function shouldForwardInput(data) {
  return !(/^\\x1b\\[(?:\\?|>|=)?[0-9;]*[cRn]$/.test(data));
}

term.onData(function(data) {
  if (!shouldForwardInput(data)) return;
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:btoa(data)}));
  var resumeTextKeyboard = shouldResumeIosTextKeyboard(data);
  rememberIosKeyboardContext(data);
  if (resumeTextKeyboard) resumeIosTextKeyboard();
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
  if (nativeKeyboardMode) {
    e.preventDefault();
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'focus'}));
    return;
  }
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
  if (nativeKeyboardMode) return;
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
  if (nativeKeyboardMode) {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'focus'}));
    return;
  }
  configureIosKeyboardContext();
  try { term.focus(); } catch (e) {}
  setTimeout(configureIosKeyboardContext, 0);
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
    const useNativeKeyboard = Platform.OS === "ios";
    const webViewRef = useRef<any>(null);
    const nativeInputRef = useRef<TextInput | null>(null);
    const dimsRef = useRef({ cols: 80, rows: 24 });
    const readyRef = useRef(false);
    const pendingWritesRef = useRef<string[]>([]);
    const nativeInputValueRef = useRef("");
    const [nativeInputValue, setNativeInputValue] = useState("");

    const sendNativeInput = useCallback(
      (text: string) => {
        if (!text || !interactive) return;
        onData?.(encodeTerminalInput(text.replace(/\n/g, "\r")));
      },
      [interactive, onData],
    );

    const setNativeInputBuffer = useCallback((value: string) => {
      const next = value.slice(-40);
      nativeInputValueRef.current = next;
      setNativeInputValue(next);
    }, []);

    const focusNativeInput = useCallback(() => {
      if (!useNativeKeyboard || !interactive) return;
      requestAnimationFrame(() => nativeInputRef.current?.focus());
    }, [interactive, useNativeKeyboard]);

    const handleNativeInputChange = useCallback(
      (value: string) => {
        const previous = nativeInputValueRef.current;
        if (value === previous) return;

        if (value.length > previous.length && value.startsWith(previous)) {
          sendNativeInput(value.slice(previous.length));
          setNativeInputBuffer(value);
          return;
        }

        if (previous.length > value.length && previous.startsWith(value)) {
          sendNativeInput("\x7f".repeat(previous.length - value.length));
          setNativeInputBuffer(value);
          return;
        }

        const prefix = commonPrefixLength(previous, value);
        const deleted = previous.length - prefix;
        const inserted = value.slice(prefix);
        if (deleted > 0) sendNativeInput("\x7f".repeat(deleted));
        if (inserted) sendNativeInput(inserted);
        setNativeInputBuffer(value);
      },
      [sendNativeInput, setNativeInputBuffer],
    );

    const handleNativeKeyPress = useCallback(
      (event: any) => {
        if (event.nativeEvent.key === "Backspace" && nativeInputValueRef.current.length === 0) {
          sendNativeInput("\x7f");
        }
      },
      [sendNativeInput],
    );

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
        nativeInputRef.current?.blur();
        webViewRef.current?.injectJavaScript(`window.blurTerminal && window.blurTerminal();true;`);
      },
      focus() {
        if (useNativeKeyboard) {
          focusNativeInput();
        } else {
          webViewRef.current?.injectJavaScript(`window.focusTerminal && window.focusTerminal();true;`);
        }
      },
      showPasteMenu() {
        webViewRef.current?.injectJavaScript(`window.showPasteMenu && window.showPasteMenu();true;`);
      },
    }));

    const handleMessage = useCallback(
      (event: any) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data);
          if (msg.type === "data" && interactive && !useNativeKeyboard) {
            onData?.(msg.data);
          } else if (msg.type === "resize") {
            dimsRef.current = { cols: msg.cols, rows: msg.rows };
            onResize?.(msg.cols, msg.rows);
          } else if (msg.type === "ready") {
            readyRef.current = true;
            if (useNativeKeyboard) {
              webViewRef.current?.injectJavaScript(`window.setNativeKeyboardMode && window.setNativeKeyboardMode(true);true;`);
            }
            flushPendingWrites();
          } else if (msg.type === "focus") {
            focusNativeInput();
          }
        } catch {
          // ignore parse errors
        }
      },
      [onData, onResize, interactive, useNativeKeyboard, flushPendingWrites, focusNativeInput],
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
        {useNativeKeyboard ? (
          <Pressable
            style={styles.nativeKeyboardTapLayer}
            onPressIn={focusNativeInput}
            accessible={false}
          />
        ) : null}
        {useNativeKeyboard ? (
          <TextInput
            ref={nativeInputRef}
            style={styles.nativeInput}
            value={nativeInputValue}
            onChangeText={handleNativeInputChange}
            onKeyPress={handleNativeKeyPress}
            onSubmitEditing={() => sendNativeInput("\r")}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            keyboardType="default"
            caretHidden
            contextMenuHidden
            importantForAutofill="no"
            editable={interactive}
            multiline
          />
        ) : null}
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
  nativeInput: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    zIndex: 2,
  },
  nativeKeyboardTapLayer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
  },
});
