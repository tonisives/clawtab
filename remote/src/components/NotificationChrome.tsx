import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, SegmentedControl } from "@clawtab/shared";

export type NotificationChromeState = {
  screen: "list" | "message" | "tasks" | "settings";
  counter: string;
  canNavigate: boolean;
  reply: boolean;
  arrival?: number;
};

function useArrivalPulse(arrival = 0) {
  const pulse = useRef(new Animated.Value(0)).current;
  const previous = useRef(arrival);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    if (previous.current === arrival) return;
    previous.current = arrival;
    let disposed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(reduceMotion => {
      if (disposed) return;
      pulse.stopAnimation(); pulse.setValue(0);
      const timing = (toValue: number) => Animated.timing(pulse, { toValue, duration: 500,
        easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true });
      Animated.sequence([timing(1), timing(0)]).start();
      // Reduce motion uses the same opacity cue without the small scale pulse.
      setReducedMotion(reduceMotion);
    });
    return () => { disposed = true; pulse.stopAnimation(); };
  }, [arrival, pulse]);
  return useMemo(() => ({ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] }),
    transform: [{ scale: reducedMotion ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] }), [pulse, reducedMotion]);
}

export const initialNotificationChrome: NotificationChromeState = {
  screen: "list", counter: "Notifications", canNavigate: false, reply: false,
};

export function NotificationChrome({ state, send, bottom, enabled, demo = false }: {
  state: NotificationChromeState;
  send: (action: string) => void;
  bottom: number;
  enabled: boolean;
  demo?: boolean;
}) {
  const navigation = useNavigation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { counter, canNavigate } = state;
  const pulseStyle = useArrivalPulse(state.arrival);
  useLayoutEffect(() => {
    if (!enabled) return;
    navigation.setOptions({
      headerShown: true,
      headerLeft: () => <Pressable accessibilityLabel="Notification menu" onPress={() => setMenuOpen(true)} hitSlop={12}>
        <Ionicons name="ellipsis-horizontal" size={24} color={colors.text} />
      </Pressable>,
      headerTitle: () => <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable accessibilityLabel="Previous notification" disabled={!canNavigate} hitSlop={8} onPress={() => send("previous")}>
          <Ionicons name="chevron-back" size={20} color={canNavigate ? colors.text : colors.textMuted} />
        </Pressable>
        <Pressable accessibilityLabel="Pending notifications" hitSlop={8} onPress={() => send("list")}>
          <Animated.View style={pulseStyle}><Text accessibilityLiveRegion="polite" style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{counter}</Text></Animated.View>
        </Pressable>
        <Pressable accessibilityLabel="Next notification" disabled={!canNavigate} hitSlop={8} onPress={() => send("next")}>
          <Ionicons name="chevron-forward" size={20} color={canNavigate ? colors.text : colors.textMuted} />
        </Pressable>
      </View>,
    });
  }, [enabled, navigation, send, counter, canNavigate, pulseStyle]);

  if (!enabled) return null;
  return <>
    {state.screen === "message" && !state.reply && !demo ? <View style={{ padding: 12, paddingBottom: Math.max(12, bottom), backgroundColor: colors.bg }}>
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
