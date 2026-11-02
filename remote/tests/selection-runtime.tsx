import { ExpoRoot, Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Button, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { MessageSurface } from "../src/components/MessageSurface";

const plainLog = "Selection starts here\nA second line of captured shell output\nDrag the selection handles across these words\nFinal line";
const coloredLog = "\x1b[31mSelection\x1b[0m \x1b[1;32mstarts\x1b[0m \x1b[38;2;90;160;230mhere\x1b[0m\nA second line of \x1b[43;30mcaptured shell\x1b[0m output\nDrag the selection handles across these words\nFinal line";
const record = { id: "selection", status: "pending", created_at: Date.now(), request: {
  title: "Selection fixture", body: "", template: "shell", source: { pane_id: "%fixture" }, actions: [],
} };

const longLog = Array.from({ length: 150 }, (_, i) => `Earlier output row ${i}`).join("\n") + "\nTarget selected at the bottom\n";

function Screen({ details = false, plain = false, long = false }: { details?: boolean; plain?: boolean; long?: boolean }) {
  const router = useRouter();
  const [copied, setCopied] = useState("");
  const log = long ? longLog : plain ? plainLog : coloredLog;
  const id = plain ? "plain" : "selection";
  return <View style={{ flex: 1, backgroundColor: "#161616" }}>
    <View style={{ flexDirection: "row" }}>
      {!details ? <Button title="Details" onPress={() => router.push("/details")} /> : null}
      {!long ? <Button title="Long" onPress={() => router.replace("/long")} /> : null}
      <Button title="Read clipboard" onPress={() => { void Clipboard.getStringAsync().then(setCopied); }} />
      <Button title="Clear" onPress={() => { setCopied(""); void Clipboard.setStringAsync(""); }} />
      {!plain ? <Button title="Plain" onPress={() => router.replace("/plain")} /> : null}
    </View>
    <Text accessible accessibilityLabel="Clipboard contents" accessibilityValue={{ text: copied }} style={{ color: "white", height: 24 }}>{copied}</Text>
    <MessageSurface selection={id} snapshot={{ type: "snapshot", remote: true, native_chrome: true,
      shell_only: details, visible: true, records: [{ ...record, id }], pending_count: 1,
      shell_cache: { [id]: log }, settings: { hover_expand: false },
      templates: { templates: [{ id: "shell", layout: [{ type: "logs" }] }] },
    }} onCommand={async command => command.op === "context" ? { log, source: record.request.source } : {}} />
  </View>;
}
const Notifications = () => <Screen />;
const Details = () => <Screen details />;
const Plain = () => <Screen plain />;
const Long = () => <Screen long />;
const Layout = () => <Stack screenOptions={{ animation: "none", headerStyle: { backgroundColor: "#161616" }, headerTintColor: "white" }}>
  <Stack.Screen name="index" options={{ title: "Notifications" }} />
  <Stack.Screen name="details" options={{ title: "Details" }} />
  <Stack.Screen name="plain" options={{ title: "Plain shell" }} />
</Stack>;
const routes: Record<string, { default: () => React.JSX.Element }> = {
  "./_layout.tsx": { default: Layout }, "./index.tsx": { default: Notifications }, "./details.tsx": { default: Details },
  "./plain.tsx": { default: Plain }, "./long.tsx": { default: Long },
};
const context = Object.assign((key: string) => routes[key], { keys: () => Object.keys(routes), resolve: (key: string) => key, id: "selection-runtime" });

export default function SelectionRuntime() {
  return <SafeAreaProvider><ExpoRoot context={context} /></SafeAreaProvider>;
}
