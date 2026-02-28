import { useRef, useEffect, useMemo, useCallback } from "react";
import { ScrollView, Text, StyleSheet, View, Platform } from "react-native";
import { colors } from "../theme/colors";
import { AnsiText, hasAnsi } from "./AnsiText";
import { collapseSeparators } from "../util/logs";

/**
 * Hook that returns a callback ref. Every time `dep` changes, scrolls
 * the element to the bottom. Works on web (DOM) and native (ScrollView).
 */
function useAutoScroll(dep: string) {
  const nativeRef = useRef<ScrollView>(null);
  const domNode = useRef<HTMLElement | null>(null);
  const first = useRef(true);

  const webRef = useCallback((node: HTMLElement | null) => {
    domNode.current = node;
  }, []);

  useEffect(() => {
    if (!dep) return;
    const isFirst = first.current;
    first.current = false;

    if (Platform.OS === "web") {
      const el = domNode.current;
      if (!el) return;
      // Double RAF to ensure layout is complete after React commit
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
    } else {
      nativeRef.current?.scrollToEnd({ animated: !isFirst });
    }
  }, [dep]);

  return { nativeRef, webRef };
}

export { useAutoScroll };

export function LogViewer({ content }: { content: string }) {
  const processed = useMemo(() => collapseSeparators(content), [content]);
  const { nativeRef, webRef } = useAutoScroll(processed);

  if (!content) {
    return (
      <View style={[styles.container, styles.empty]}>
        <Text style={styles.emptyText}>No log output</Text>
      </View>
    );
  }

  const inner = hasAnsi(processed) ? (
    <AnsiText content={processed} style={styles.text} selectable />
  ) : (
    <Text style={styles.text} selectable>{processed}</Text>
  );

  if (Platform.OS === "web") {
    return (
      <div
        ref={webRef as any}
        style={{
          flex: 1,
          backgroundColor: "#000",
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
          padding: 12,
          overflow: "auto",
          minHeight: 0,
        }}
      >
        {inner}
      </div>
    );
  }

  return (
    <ScrollView
      ref={nativeRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      nestedScrollEnabled
    >
      {inner}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: {
    padding: 12,
  },
  text: {
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
    color: colors.text,
  },
  empty: {
    justifyContent: "center",
    alignItems: "center",
    minHeight: 120,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
