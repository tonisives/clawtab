import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, SegmentedControl } from "@clawtab/shared";

export type NotificationChromeState = {
  screen: "list" | "message" | "tasks" | "settings";
  counter: string;
  canNavigate: boolean;
  reply: boolean;
};

export const initialNotificationChrome: NotificationChromeState = {
  screen: "list", counter: "Notifications", canNavigate: false, reply: false,
};

export function NotificationChrome({ state, send, bottom, enabled }: {
  state: NotificationChromeState;
  send: (action: string) => void;
  bottom: number;
  enabled: boolean;
}) {
  const navigation = useNavigation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    navigation.setOptions({
      headerShown: true,
      headerLeft: () => <Pressable accessibilityLabel="Notification menu" onPress={() => setMenuOpen(true)} hitSlop={12}>
        <Ionicons name="ellipsis-horizontal" size={24} color={colors.text} />
      </Pressable>,
      headerTitle: () => <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable accessibilityLabel="Previous notification" disabled={!state.canNavigate} hitSlop={8} onPress={() => send("previous")}>
          <Ionicons name="chevron-back" size={20} color={state.canNavigate ? colors.text : colors.textMuted} />
        </Pressable>
        <Pressable accessibilityLabel="Pending notifications" hitSlop={8} onPress={() => send("list")}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{state.counter}</Text>
        </Pressable>
        <Pressable accessibilityLabel="Next notification" disabled={!state.canNavigate} hitSlop={8} onPress={() => send("next")}>
          <Ionicons name="chevron-forward" size={20} color={state.canNavigate ? colors.text : colors.textMuted} />
        </Pressable>
      </View>,
    });
  }, [enabled, navigation, send, state]);

  if (!enabled) return null;
  return <>
    {state.screen === "message" && !state.reply ? <View style={{ padding: 12, paddingBottom: Math.max(12, bottom), backgroundColor: colors.bg }}>
      <SegmentedControl label="Message actions" value={null} stretch
        options={[{ value: "open", label: "Open" }, { value: "got_it", label: "Got it" }, { value: "reply", label: "Reply" }]}
        onChange={send} style={{ alignSelf: "stretch" }} />
    </View> : null}
    <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <Pressable onPress={() => setMenuOpen(false)} style={{ flex: 1, backgroundColor: "#00000080", justifyContent: "center", padding: 24 }}>
        <View accessibilityViewIsModal style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 8, borderWidth: 1, borderColor: colors.border }}>
          {[{ action: "list", label: "Pending notifications" }, { action: "tasks", label: "Tasks" }].map(item =>
            <Pressable key={item.action} onPress={() => { setMenuOpen(false); send(item.action); }} style={{ padding: 16 }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>{item.label}</Text>
            </Pressable>)}
        </View>
      </Pressable>
    </Modal>
  </>;
}
