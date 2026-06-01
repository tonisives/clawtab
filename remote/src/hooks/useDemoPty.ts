import { useEffect } from "react";
import { DEMO_PTY_OUTPUT_BY_PANE } from "../demo/data";
import { dispatchPtyOutput } from "./usePty";

function bytesToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += i + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? chars[triplet & 63] : "=";
  }
  return output;
}

function encodeBase64(text: string): string {
  if (typeof TextEncoder !== "undefined") {
    return bytesToBase64(new TextEncoder().encode(text));
  }
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(text)));
  return bytesToBase64(Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff));
}

export function useDemoPty(paneId: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const output = DEMO_PTY_OUTPUT_BY_PANE[paneId];
    if (!output) return;
    const terminalOutput = "\x1bc\x1b[?7l" + output.replace(/\r?\n/g, "\r\n");
    const encoded = encodeBase64(terminalOutput);
    const timers = [180, 500, 1200].map((delay) =>
      setTimeout(() => dispatchPtyOutput(paneId, encoded), delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [enabled, paneId]);
}
