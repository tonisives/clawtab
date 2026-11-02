import { forwardRef, useRef, useState, type ComponentRef } from "react";
import { TextInput } from "react-native";
import { shellKeyboardEdit } from "../lib/shellKeyboardEdit";

// Keep shell editing outside WKWebView. Its hidden textarea leaves WebKit in
// editing mode, where a long press on the separate output cannot select a word.
export const ShellKeyboardInput = forwardRef<ComponentRef<typeof TextInput>, { onSend: (text: string) => void }>(function ShellKeyboardInput({ onSend }, ref) {
  const previous = useRef("");
  const [value, setValue] = useState("");
  return <TextInput ref={ref} accessibilityLabel="Type into shell" multiline
    value={value} onChangeText={next => {
      const text = shellKeyboardEdit(previous.current, next);
      previous.current = next; setValue(next);
      if (text) onSend(text);
    }}
    onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === "Backspace" && !previous.current) onSend("\x7f"); }}
    autoCapitalize="none" autoCorrect={false} spellCheck={false} textContentType="none"
    keyboardAppearance="dark" caretHidden contextMenuHidden scrollEnabled={false}
    style={{ position: "absolute", width: 1, height: 1, opacity: 0, top: 0, left: 0, padding: 0, fontSize: 16 }} />;
});
