import { View, StyleSheet } from "react-native";
import { useResponsive, CONTENT_MAX_WIDTH, WIDE_CONTENT_MAX_WIDTH } from "../hooks/useResponsive";

export function ContentContainer({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { isWide } = useResponsive();

  if (!isWide) return <>{children}</>;

  return (
    <View style={styles.outer}>
      <View style={[styles.inner, { maxWidth: wide ? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH }]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: "center",
  },
  inner: {
    flex: 1,
    width: "100%",
  },
});
