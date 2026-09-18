import { encodeTerminalInput } from "../util/terminalInput";
import { useRef, useImperativeHandle, forwardRef, useCallback, useEffect, useMemo } from "react";
import { View, StyleSheet, TextInput, Platform, Pressable } from "react-native";
import { TERMINAL_CUSTOM_GLYPHS, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from "../theme/terminal";

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
  forceDarkTheme?: boolean;
  /** Keep a taller native terminal grid for quick touch scrolling. */
  extendedViewport?: boolean;
  /** Called with the currently visible terminal text after a native long press. */
  onLongPressCopyText?: (text: string) => void;
  /** Font size in terminal pixels. */
  fontSize?: number;
  /** Called when the user scrolls toward older or newer terminal content. */
  onScrollGesture?: (direction: "up" | "down") => void;
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
#terminal{height:__VIEWPORT_HEIGHT__%;width:100%}
</style>
</head>
<body>
<div id="terminal"></div>
<script>
var extendedViewport = __EXTENDED_VIEWPORT__;
var term = new Terminal({
  fontSize: ${TERMINAL_FONT_SIZE},
  fontFamily: ${JSON.stringify(TERMINAL_FONT_FAMILY)},
  lineHeight: ${TERMINAL_LINE_HEIGHT},
  letterSpacing: 0,
  customGlyphs: ${TERMINAL_CUSTOM_GLYPHS},
  rescaleOverlappingGlyphs: true,
  cursorStyle: 'bar',
  cursorInactiveStyle: 'bar',
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
  // Tmux copy mode handles older history. The optional taller grid below gives
  // touch scrolling room within the live pane without a scrollbar gutter.
  scrollback: 0,
  disableStdin: false
});
var fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

var terminalWriteQueue = [];
var terminalWriteBusy = false;
function drainTerminalWriteQueue() {
  if (terminalWriteBusy) return;
  var item = terminalWriteQueue.shift();
  if (!item) return;
  terminalWriteBusy = true;
  if (item.type === 'reset') {
    term.reset();
    if (window.applyVisualOffset) window.applyVisualOffset();
    terminalWriteBusy = false;
    setTimeout(drainTerminalWriteQueue, 0);
    return;
  }
  if (item.type === 'text') {
    term.write(item.text || '', function() {
      if (window.applyVisualOffset) window.applyVisualOffset();
      terminalWriteBusy = false;
      drainTerminalWriteQueue();
    });
    return;
  }
  var bytes = Uint8Array.from(atob(item.data || ''), function(c) { return c.charCodeAt(0); });
  term.write(bytes, function() {
    if (window.applyVisualOffset) window.applyVisualOffset();
    terminalWriteBusy = false;
    drainTerminalWriteQueue();
  });
}
window.enqueueTerminalWrite = function(b64) {
  terminalWriteQueue.push({type:'write',data:b64});
  drainTerminalWriteQueue();
};
window.enqueueTerminalText = function(text) {
  terminalWriteQueue.push({type:'text',text:text});
  drainTerminalWriteQueue();
};
window.enqueueTerminalReset = function() {
  terminalWriteQueue.push({type:'reset'});
  drainTerminalWriteQueue();
};

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

var encodeTerminalInput = ${encodeTerminalInput.toString()};
term.onData(function(data) {
  if (!shouldForwardInput(data)) return;
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:encodeTerminalInput(data)}));
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
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'data',data:encodeTerminalInput(text)}));
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
var touchLastY = null;
var touchMoved = false;
document.getElementById('terminal').addEventListener('touchstart', function(e) {
  touchLastY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
  touchMoved = false;
  if (nativeKeyboardMode) return;
  if (longPressTimer) clearTimeout(longPressTimer);
  var touch = e.touches && e.touches[0];
  longPressTimer = setTimeout(function() {
    if (touch) showPasteTarget(touch.clientX, touch.clientY);
  }, 450);
}, { passive: true });
document.getElementById('terminal').addEventListener('touchmove', function(e) {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  var y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
  if (y !== null && touchLastY !== null) {
    var delta = touchLastY - y;
    if (Math.abs(delta) > 2) touchMoved = true;
    if (extendedViewport && touchMoved) {
      window.scrollTerminalViewport(delta);
      e.preventDefault();
    }
  }
  touchLastY = y;
}, { passive: false });
document.getElementById('terminal').addEventListener('touchend', function() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  if (nativeKeyboardMode && !touchMoved) {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'focus'}));
  }
  touchLastY = null;
}, { passive: true });
document.getElementById('terminal').addEventListener('dblclick', function(e) {
  if (nativeKeyboardMode) return;
  showPasteTarget(e.clientX, e.clientY);
});

var lastReportedCols = 0;
var lastReportedRows = 0;
function reportResize() {
  if (!term.cols || !term.rows) return;
  if (term.cols === lastReportedCols && term.rows === lastReportedRows) return;
  lastReportedCols = term.cols;
  lastReportedRows = term.rows;
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
}
window.setTerminalFontSize = function(size) {
  var next = Math.max(9, Math.min(22, Math.round(size)));
  if (term.options.fontSize === next) return;
  term.options.fontSize = next;
  fit.fit();
  reportResize();
  if (window.applyVisualOffset) window.applyVisualOffset();
};
var ro = new ResizeObserver(function() {
  fit.fit();
  reportResize();
  if (window.applyVisualOffset) window.applyVisualOffset();
});
ro.observe(document.getElementById('terminal'));

reportResize();
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
var visualOffsetMax = 0;
var viewportScroll = 0;
var followingOutput = true;
window.applyVisualOffset = function() {
  term.options.cursorStyle = 'bar';
  term.options.cursorInactiveStyle = 'bar';
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
  var visibleHeight = Math.max(0, window.innerHeight - maxPx);
  var bottomScroll = Math.max(0, Math.ceil(contentBottom - visibleHeight));
  var limit = Math.max(0, el.clientHeight - visibleHeight);
  if (followingOutput) viewportScroll = bottomScroll;
  viewportScroll = Math.max(0, Math.min(limit, viewportScroll));
  el.style.transform = viewportScroll ? 'translate3d(0,' + (-viewportScroll) + 'px,0)' : '';
  el.style.transition = 'none';
};
window.setVisualOffset = function(px) {
  visualOffsetMax = px || 0;
  window.applyVisualOffset();
};
window.scrollTerminalViewport = function(delta) {
  var el = document.getElementById('terminal');
  if (!el || !extendedViewport) return;
  var visibleHeight = Math.max(0, window.innerHeight - visualOffsetMax);
  var lastContentY = 0;
  var buffer = term.buffer && term.buffer.active;
  if (buffer) {
    for (var y = term.rows - 1; y >= 0; y--) {
      var line = buffer.getLine(buffer.viewportY + y);
      if (line && line.translateToString(true).trim().length) { lastContentY = y; break; }
    }
  }
  var limit = Math.max(0, Math.min(el.clientHeight - visibleHeight, Math.ceil((lastContentY + 1) * el.clientHeight / Math.max(1, term.rows) - visibleHeight)));
  viewportScroll = Math.max(0, Math.min(limit, viewportScroll + delta));
  followingOutput = delta > 0 && viewportScroll >= limit - 12;
  window.applyVisualOffset();
};
var flingFrame = 0;
window.stopTerminalFling = function() {
  if (flingFrame) cancelAnimationFrame(flingFrame);
  flingFrame = 0;
};
window.flingTerminalViewport = function(velocity) {
  window.stopTerminalFling();
  if (!extendedViewport || Math.abs(velocity) < 0.12) return;
  var lastTime = performance.now();
  function step(now) {
    var elapsed = Math.min(32, now - lastTime);
    lastTime = now;
    window.scrollTerminalViewport(velocity * elapsed);
    velocity *= Math.pow(0.92, elapsed / 16);
    if (Math.abs(velocity) >= 0.02) flingFrame = requestAnimationFrame(step);
    else flingFrame = 0;
  }
  flingFrame = requestAnimationFrame(step);
};
window.copyVisibleTerminalText = function() {
  var buffer = term.buffer && term.buffer.active;
  if (!buffer) return;
  var el = document.getElementById('terminal');
  var rowHeight = el.clientHeight / Math.max(1, term.rows);
  var first = Math.max(0, Math.floor(viewportScroll / rowHeight));
  var count = Math.min(term.rows - first, Math.ceil((window.innerHeight - visualOffsetMax) / rowHeight) + 1);
  var lines = [];
  for (var y = first; y < first + count; y++) {
    var line = buffer.getLine(buffer.viewportY + y);
    var value = line ? line.translateToString(true) : '';
    if (line && line.isWrapped && lines.length) lines[lines.length - 1] += value;
    else lines.push(value);
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'copy-text',text:lines.join('\\n').trimEnd()}));
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
  function XtermLog({ onData, onResize, interactive = true, extendedViewport = false, onLongPressCopyText, fontSize = TERMINAL_FONT_SIZE, onScrollGesture }, ref) {
    const terminalSource = useMemo(() => ({
      html: XTERM_HTML.replace("__VIEWPORT_HEIGHT__", extendedViewport ? "250" : "100")
        .replace("__EXTENDED_VIEWPORT__", extendedViewport ? "true" : "false"),
    }), [extendedViewport]);
    const useNativeKeyboard = Platform.OS === "ios";
    const webViewRef = useRef<any>(null);
    const nativeInputRef = useRef<TextInput | null>(null);
    const dimsRef = useRef({ cols: 0, rows: 0 });
    const lastResizeRef = useRef({ cols: 0, rows: 0 });
    const readyRef = useRef(false);
    const pendingWritesRef = useRef<string[]>([]);
    const nativeInputValueRef = useRef("");
    const lastTouchYRef = useRef<number | null>(null);
    const touchOriginYRef = useRef<number | null>(null);
    const touchMovedRef = useRef(false);
    const longPressedRef = useRef(false);
    const lastTouchTimeRef = useRef(0);
    const touchVelocityRef = useRef(0);

    const sendNativeInput = useCallback(
      (text: string) => {
        if (!text || !interactive) return;
        onData?.(encodeTerminalInput(text.replace(/\n/g, "\r")));
      },
      [interactive, onData],
    );

    const setNativeInputBuffer = useCallback((value: string) => {
      nativeInputValueRef.current = value;
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

    // Queue resets and plain text alongside bytes until the page is ready.
    // Separate queues can replay stale output after a reconnect reset.
    let injectOperation = useCallback((script: string) => {
      if (!readyRef.current) {
        pendingWritesRef.current.push(script);
        return;
      }
      webViewRef.current?.injectJavaScript(script);
    }, []);

    useEffect(() => {
      injectOperation(`window.setTerminalFontSize && window.setTerminalFontSize(${Math.max(9, Math.min(22, fontSize))});true;`);
    }, [fontSize, injectOperation]);

    const flushPendingWrites = useCallback(() => {
      if (!readyRef.current) return;
      for (let script of pendingWritesRef.current) webViewRef.current?.injectJavaScript(script);
      pendingWritesRef.current = [];
    }, []);

    useImperativeHandle(ref, () => ({
      write(b64: string) {
        injectOperation(`window.enqueueTerminalWrite(${JSON.stringify(b64)});true;`);
      },
      writeText(text: string) {
        let normalised = text.replace(/\r?\n/g, "\r\n");
        injectOperation(`window.enqueueTerminalText(${JSON.stringify(normalised)});true;`);
      },
      clear() {
        injectOperation(`window.enqueueTerminalReset();true;`);
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
            if (!Number.isFinite(msg.cols) || !Number.isFinite(msg.rows) || msg.cols <= 0 || msg.rows <= 0) return;
            const cols = Math.round(msg.cols);
            const rows = Math.round(msg.rows);
            if (cols === lastResizeRef.current.cols && rows === lastResizeRef.current.rows) return;
            lastResizeRef.current = { cols, rows };
            dimsRef.current = { cols, rows };
            onResize?.(cols, rows);
          } else if (msg.type === "ready") {
            readyRef.current = true;
            if (useNativeKeyboard) {
              webViewRef.current?.injectJavaScript(`window.setNativeKeyboardMode && window.setNativeKeyboardMode(true);true;`);
            }
            flushPendingWrites();
          } else if (msg.type === "focus") {
            focusNativeInput();
          } else if (msg.type === "copy-text" && typeof msg.text === "string") {
            onLongPressCopyText?.(msg.text);
          }
        } catch {
          // ignore parse errors
        }
      },
      [onData, onResize, interactive, useNativeKeyboard, flushPendingWrites, focusNativeInput, onLongPressCopyText],
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
          source={terminalSource}
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
            onPress={() => { if (!touchMovedRef.current && !longPressedRef.current) focusNativeInput(); }}
            onLongPress={() => {
              longPressedRef.current = true;
              touchMovedRef.current = true;
              nativeInputRef.current?.blur();
              webViewRef.current?.injectJavaScript("window.copyVisibleTerminalText && window.copyVisibleTerminalText();true;");
            }}
            onTouchStart={(event) => {
              lastTouchYRef.current = event.nativeEvent.touches[0]?.pageY ?? null;
              touchOriginYRef.current = lastTouchYRef.current;
              touchMovedRef.current = false;
              longPressedRef.current = false;
              lastTouchTimeRef.current = Date.now();
              touchVelocityRef.current = 0;
              webViewRef.current?.injectJavaScript("window.stopTerminalFling && window.stopTerminalFling();true;");
            }}
            onTouchMove={(event) => {
              const y = event.nativeEvent.touches[0]?.pageY;
              const previous = lastTouchYRef.current;
              if (y === undefined || previous === null) return;
              lastTouchYRef.current = y;
              if (touchOriginYRef.current !== null && Math.abs(touchOriginYRef.current - y) > 8) touchMovedRef.current = true;
              if (!extendedViewport) return;
              const delta = previous - y;
              if (touchMovedRef.current && Math.abs(delta) > 2) onScrollGesture?.(delta > 0 ? "down" : "up");
              const now = Date.now();
              const elapsed = now - lastTouchTimeRef.current;
              if (elapsed > 0 && elapsed < 100) touchVelocityRef.current = Math.max(-2.5, Math.min(2.5, delta / elapsed));
              lastTouchTimeRef.current = now;
              if (delta) webViewRef.current?.injectJavaScript(`window.scrollTerminalViewport && window.scrollTerminalViewport(${delta});true;`);
            }}
            onTouchEnd={() => {
              if (touchMovedRef.current && Date.now() - lastTouchTimeRef.current < 100) {
                webViewRef.current?.injectJavaScript(`window.flingTerminalViewport && window.flingTerminalViewport(${touchVelocityRef.current});true;`);
              }
              lastTouchYRef.current = null;
              touchOriginYRef.current = null;
            }}
            accessible={false}
          />
        ) : null}
        {useNativeKeyboard ? (
          <TextInput
            ref={nativeInputRef}
            style={styles.nativeInput}
            // Keep the native edit buffer authoritative. Feeding a truncated value
            // back into it races queued iOS edits and repeats characters.
            defaultValue=""
            onChangeText={handleNativeInputChange}
            onKeyPress={handleNativeKeyPress}
            onSubmitEditing={() => sendNativeInput("\r")}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            // iOS smart dashes and quotes remain enabled on the default keyboard
            // even with autocorrection off, corrupting shell flags and strings.
            keyboardType="ascii-capable"
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
