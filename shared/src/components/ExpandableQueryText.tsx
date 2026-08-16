import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import type { StyleProp, TextStyle } from "react-native";

type ExpandableQueryTextProps = {
  text: string;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
};

export function ExpandableQueryText({ text, style, accessibilityLabel }: ExpandableQueryTextProps) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);

  return (
    <Pressable
      style={styles.container}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? text}
      accessibilityHint={expanded ? "Collapse query" : "Expand query"}
    >
      <Text
        style={style}
        numberOfLines={expanded ? 4 : 1}
        ellipsizeMode={expanded ? "middle" : "tail"}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
  },
});
