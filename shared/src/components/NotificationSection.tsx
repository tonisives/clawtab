import { useCallback, useRef, useState } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { ClaudeQuestion } from "../types/process";
import { NotificationCard } from "./NotificationCard";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { shortenPath } from "../util/format";

export interface NotificationSectionProps {
  questions: ClaudeQuestion[];
  resolveJob: (q: ClaudeQuestion) => string | null;
  onNavigate: (q: ClaudeQuestion, resolvedJob: string | null) => void;
  onSendOption: (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function NotificationSection({
  questions,
  resolveJob,
  onNavigate,
  onSendOption,
  collapsed,
  onToggleCollapse,
}: NotificationSectionProps) {
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cardWidth, setCardWidth] = useState(0);

  const count = questions.length;
  if (count === 0) return null;

  const clampedIndex = Math.min(activeIndex, count - 1);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (cardWidth <= 0) return;
      const offset = e.nativeEvent.contentOffset.x;
      const idx = Math.round(offset / cardWidth);
      setActiveIndex(idx);
    },
    [cardWidth],
  );

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) => {
      setCardWidth(e.nativeEvent.layout.width);
    },
    [],
  );

  const scrollToIndex = useCallback(
    (idx: number) => {
      if (cardWidth <= 0) return;
      scrollRef.current?.scrollTo({ x: idx * cardWidth, animated: true });
      setActiveIndex(idx);
    },
    [cardWidth],
  );

  const goPrev = useCallback(() => {
    if (clampedIndex > 0) scrollToIndex(clampedIndex - 1);
  }, [clampedIndex, scrollToIndex]);

  const goNext = useCallback(() => {
    if (clampedIndex < count - 1) scrollToIndex(clampedIndex + 1);
  }, [clampedIndex, count, scrollToIndex]);

  const prevPath = clampedIndex > 0 ? shortenPath(questions[clampedIndex - 1].cwd) : null;
  const nextPath = clampedIndex < count - 1 ? shortenPath(questions[clampedIndex + 1].cwd) : null;

  return (
    <View style={styles.container}>
      {/* Collapsible header */}
      <TouchableOpacity
        onPress={onToggleCollapse}
        style={styles.headerRow}
        activeOpacity={0.6}
      >
        <Text style={styles.headerArrow}>
          {collapsed ? "\u25B6" : "\u25BC"}
        </Text>
        <Text style={styles.headerText}>Waiting for input</Text>
        <View style={styles.headerRight}>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{count}</Text>
          </View>
        </View>
      </TouchableOpacity>

      {!collapsed && (
        <View onLayout={handleLayout}>
          {/* Nav row - only show when multiple questions */}
          {count > 1 && (
            <View style={styles.navRow}>
              <TouchableOpacity
                onPress={goPrev}
                disabled={clampedIndex === 0}
                style={styles.navBtn}
                activeOpacity={0.6}
              >
                <Text style={[styles.navBtnText, clampedIndex === 0 && styles.navBtnDisabled]}>
                  {prevPath ? `\u2039 ${prevPath}` : ""}
                </Text>
              </TouchableOpacity>

              <Text style={styles.navCounter}>
                {clampedIndex + 1}/{count}
              </Text>

              <TouchableOpacity
                onPress={goNext}
                disabled={clampedIndex >= count - 1}
                style={styles.navBtn}
                activeOpacity={0.6}
              >
                <Text
                  style={[
                    styles.navBtnText,
                    styles.navBtnRight,
                    clampedIndex >= count - 1 && styles.navBtnDisabled,
                  ]}
                >
                  {nextPath ? `${nextPath} \u203A` : ""}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Horizontal scroller */}
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
          >
            {questions.map((q) => (
              <View key={q.question_id} style={{ width: cardWidth || "100%" }}>
                <NotificationCard
                  question={q}
                  resolvedJob={resolveJob(q)}
                  onNavigate={onNavigate}
                  onSendOption={onSendOption}
                />
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  // Header - matches AgentSection/group header pattern
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  headerArrow: {
    fontFamily: "monospace",
    fontSize: 9,
    color: colors.warning,
  },
  headerText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginLeft: "auto",
  },
  countBadge: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  countText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "600",
  },
  // Nav row
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  navBtn: {
    flex: 1,
  },
  navBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  navBtnRight: {
    textAlign: "right",
  },
  navBtnDisabled: {
    opacity: 0,
  },
  navCounter: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    minWidth: 30,
  },
});
