import { useRef, useEffect } from "react";
import { ScrollView, Text, StyleSheet, View } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function LogViewer({ content }: { content: string }) {
  const scrollRef = useRef<ScrollView>(null);
  const hasScrolled = useRef(false);

  useEffect(() => {
    // First scroll is instant so the user sees the end immediately;
    // subsequent updates animate smoothly.
    const animated = hasScrolled.current;
    hasScrolled.current = true;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated });
    }, 50);
    return () => clearTimeout(timer);
  }, [content]);

  if (!content) {
    return (
      <View style={[styles.container, styles.empty]}>
        <Text style={styles.emptyText}>No log output</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      nestedScrollEnabled
    >
      <Text style={styles.text} selectable>
        {content}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: {
    padding: spacing.md,
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
