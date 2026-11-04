import { type ComponentRef, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { ClawMark } from "./ClawMark";
import { startupBackground } from "../lib/clawArrivalDocument";

type Target = { x: number; y: number; width: number; height: number };
const StartupContext = createContext({ visible: false, setTarget: (_target: Target) => {} });
const SIZE = 192;
const curve = Easing.bezier(0.22, 1, 0.36, 1);

export function StartupLoginMark() {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const { visible, setTarget } = useContext(StartupContext);
  const measure = () => ref.current?.measureInWindow((x, y, width, height) => {
    if (width && height) setTarget({ x, y, width, height });
  });
  return <View ref={ref} collapsable={false} onLayout={measure}
    style={{ width: 116, height: 116, marginBottom: 16 }} accessibilityLabel="ClawTab" accessibilityRole="image">
    <View style={{ flex: 1, opacity: visible ? 0 : 1 }}><ClawMark settled /></View>
  </View>;
}

export function StartupTransition({ ready, authenticated, children }: {
  ready: boolean; authenticated: boolean; children: React.ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const [visible, setVisible] = useState(true);
  const [target, setTarget] = useState<Target | null>(null);
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [slashed, setSlashed] = useState(false);
  const exit = useRef(new Animated.Value(0)).current;
  const started = useRef(false);
  const exiting = useRef(false);
  const reveal = useCallback(() => {
    if (Platform.OS !== "web") void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    const timeout = setTimeout(reveal, 600);
    return () => clearTimeout(timeout);
  }, [reveal]);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); })
      .catch(() => { if (active) setReducedMotion(false); });
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { active = false; listener.remove(); };
  }, []);

  useEffect(() => {
    if (!ready || reducedMotion === null || started.current) return;
    started.current = true;
    if (reducedMotion) setSlashed(true);
    else setPlaying(true);
  }, [ready, reducedMotion]);

  const complete = useCallback(() => setSlashed(true), []);
  useEffect(() => {
    if (playing && reducedMotion) { setPlaying(false); setSlashed(true); }
  }, [playing, reducedMotion]);

  useEffect(() => {
    if (!playing || slashed) return;
    // The local vector document normally completes in 1.57 seconds. A failed
    // WebView must still release the app, including when it resumes from sleep.
    const timeout = setTimeout(complete, 2200);
    return () => clearTimeout(timeout);
  }, [playing, slashed, complete]);

  useEffect(() => {
    if (!slashed || exiting.current) return;
    // Login measures its real destination after the initial route redirect.
    // Direct links to other screens use the same fade as an authenticated launch.
    const timeout = setTimeout(() => {
      exiting.current = true;
      Animated.timing(exit, { toValue: 1, duration: reducedMotion ? 200 : 500,
        easing: curve, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    }, !authenticated && !target ? 300 : 0);
    return () => clearTimeout(timeout);
  }, [slashed, authenticated, target, reducedMotion, exit]);

  useEffect(() => () => exit.stopAnimation(), [exit]);

  const dock = !authenticated && target && !reducedMotion;
  const translateX = dock ? target.x + target.width / 2 - width / 2 : 0;
  const translateY = dock ? target.y + target.height / 2 - height / 2 : 0;
  const scale = dock ? target.width / SIZE : reducedMotion ? 1 : 1.35;
  const opacity = dock ? 1 : exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  return <StartupContext.Provider value={{ visible, setTarget }}>
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.root} pointerEvents={visible ? "none" : "auto"}
        accessibilityElementsHidden={visible} importantForAccessibility={visible ? "no-hide-descendants" : "auto"}>
        {children}
      </View>
      {visible && <View style={StyleSheet.absoluteFill} accessibilityRole="progressbar" accessibilityLabel="Loading ClawTab">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: startupBackground,
          opacity: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]} />
        <Animated.View style={{ position: "absolute", left: (width - SIZE) / 2, top: (height - SIZE) / 2,
          width: SIZE, height: SIZE, opacity, transform: [
            { translateX: exit.interpolate({ inputRange: [0, 1], outputRange: [0, translateX] }) },
            { translateY: exit.interpolate({ inputRange: [0, 1], outputRange: [0, translateY] }) },
            { scale: exit.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) },
          ] }}>
          <ClawMark playing={playing} settled={!playing} onComplete={complete} onReady={reveal} />
        </Animated.View>
      </View>}
    </View>
  </StartupContext.Provider>;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: startupBackground } });
