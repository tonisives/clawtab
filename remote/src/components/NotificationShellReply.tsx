import { useEffect, useRef, useState } from "react";
import { Keyboard, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { XtermLog, encodeTerminalInput, colors, type XtermLogHandle } from "@clawtab/shared";
import { usePty } from "../hooks/usePty";
import { useTerminalKeyboard } from "../hooks/useTerminalKeyboard";
import { TerminalKeyboardToolbar, TERMINAL_KEYBOARD_TOOLBAR_HEIGHT } from "./TerminalKeyboardToolbar";
import { TerminalWriteDialog } from "./TerminalWriteDialog";

export function NotificationShellReply({ paneId, tmuxSession, onClose }: {
  paneId: string; tmuxSession: string; onClose: () => void;
}) {
  const termRef = useRef<XtermLogHandle | null>(null);
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { sendInput, sendResize, error } = usePty(paneId, tmuxSession, termRef);
  const keyboard = useTerminalKeyboard({ termRef, menuOpen, toolbarHeight: TERMINAL_KEYBOARD_TOOLBAR_HEIGHT, extraClearance: 10, overlayHeight: TERMINAL_KEYBOARD_TOOLBAR_HEIGHT + insets.bottom });
  const send = (text: string) => sendInput(encodeTerminalInput(text));
  const close = () => { termRef.current?.blur(); Keyboard.dismiss(); onClose(); };
  useEffect(() => { const timer = setTimeout(() => termRef.current?.focus(), 300); return () => clearTimeout(timer); }, []);
  return <View style={{ position: "absolute", inset: 0, paddingTop: insets.top, backgroundColor: colors.bg }}>
    {error ? <Text style={{ color: colors.danger, padding: 12 }}>{error}</Text> : null}
    <View ref={keyboard.terminalSurfaceRef} onLayout={keyboard.handleTerminalLayout} style={{ flex: 1, minHeight: 0 }}>
      <XtermLog ref={termRef} onData={sendInput} onResize={sendResize} interactive forceDarkTheme />
    </View>
    <TerminalKeyboardToolbar bottom={keyboard.keyboardVisible ? keyboard.keyboardHeight : insets.bottom}
      onDismiss={close} dismissIcon="close" onSend={send} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen}
      onWrite={() => { setMenuOpen(false); setWriteOpen(true); }} />
    <TerminalWriteDialog visible={writeOpen} draft={draft} onDraftChange={setDraft} onClose={() => setWriteOpen(false)}
      onDone={() => { send(draft.replace(/\r\n|\n/g, "\r") + "\r"); setDraft(""); setWriteOpen(false); }} />
  </View>;
}
