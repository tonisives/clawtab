import { View, StyleSheet } from "react-native";
import { useResponsive, CONTENT_MAX_WIDTH, WIDE_CONTENT_MAX_WIDTH } from "../hooks/useResponsive";

export function ContentContainer({
  children,
  wide,
  fill,
}: {
  children: React.ReactNode;
  wide?: boolean;
  fill?: boolean;
}) {
  const { isWide } = useResponsive();

  if (!isWide) return <>{children}</>;

  return (
    <View style={[styles.outer, fill && styles.fill]}>
      <View style={[styles.inner, fill && styles.fill, { maxWidth: wide ? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH }]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    alignItems: "center",
  },
  inner: {
    width: "100%",
  },
  fill: {
    flex: 1,
  },
});
