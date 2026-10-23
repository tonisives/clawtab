import { Text, type TextStyle } from "react-native";
import { useMemo } from "react";
import { parseAnsi } from "../util/ansi";

/** Returns true if the string contains ANSI escape codes. */
export function hasAnsi(s: string): boolean {
  return s.includes("\x1b");
}

export function AnsiText({
  content,
  style,
  selectable,
  showBackgrounds = true,
}: {
  content: string;
  style?: TextStyle;
  selectable?: boolean;
  showBackgrounds?: boolean;
}) {
  const spans = useMemo(
    () => parseAnsi(content, style?.color as string | undefined, undefined, showBackgrounds),
    [content, style?.color, showBackgrounds],
  );
  if (spans.length === 0) return null;

  return (
    <Text style={style} selectable={selectable}>
      {spans.map((span, i) => (
        <Text key={i} style={span.style}>{span.text}</Text>
      ))}
    </Text>
  );
}
