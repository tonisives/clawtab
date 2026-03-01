import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { ClaudeQuestion } from "../types/process";
import { NotificationCard } from "./NotificationCard";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";
import { shortenPath } from "../util/format";

const isWeb = Platform.OS === "web";

export interface NotificationSectionProps {
  questions: ClaudeQuestion[];
  resolveJob: (q: ClaudeQuestion) => string | null;
  onNavigate: (q: ClaudeQuestion, resolvedJob: string | null) => void;
  onSendOption: (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  autoYesPaneIds?: Set<string>;
  onToggleAutoYes?: (question: ClaudeQuestion) => void;
  /** Question IDs that were auto-answered (shown briefly before dismissal) */
  autoAnsweredIds?: Set<string>;
}

interface DepartingQuestion {
  question: ClaudeQuestion;
  anim: Animated.Value;
  phase: "entering" | "leaving";
}

export function NotificationSection({
  questions,
  resolveJob,
  onNavigate,
  onSendOption,
  collapsed,
  onToggleCollapse,
  autoYesPaneIds,
  onToggleAutoYes,
  autoAnsweredIds,
}: NotificationSectionProps) {
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cardWidth, setCardWidth] = useState(0);
  const [departing, setDeparting] = useState<DepartingQuestion[]>([]);
  const prevQuestionsRef = useRef<ClaudeQuestion[]>([]);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const entranceAnims = useRef<Map<string, Animated.Value>>(new Map());
  // Track answered question IDs so we skip departing animations for them
  // (the card already plays its own fly-away animation before removal)
  const answeredIds = useRef<Set<string>>(new Set());

  const wrappedOnSendOption = useCallback(
    (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
      answeredIds.current.add(q.question_id);
      onSendOption(q, resolvedJob, optionNumber);
    },
    [onSendOption],
  );

  // Detect added/removed questions and animate
  useEffect(() => {
    const prev = prevQuestionsRef.current;
    const currentIds = new Set(questions.map((q) => q.question_id));
    const prevIds = new Set(prev.map((q) => q.question_id));
    const allRemoved = prev.filter((q) => !currentIds.has(q.question_id));
    // Only animate departures for questions that weren't answered via action buttons
    // (answered cards already play their own fly-away animation)
    const removed = allRemoved.filter((q) => !answeredIds.current.has(q.question_id));
    const added = questions.filter((q) => !prevIds.has(q.question_id));
    prevQuestionsRef.current = questions;

    // Clean up answered tracking for removed questions
    for (const q of allRemoved) answeredIds.current.delete(q.question_id);

    // Entrance animations for new questions
    if (added.length > 0) {
      if (isWeb) {
        const ids = new Set(added.map((q) => q.question_id));
        setEntering(ids);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setEntering(new Set());
          });
        });
      } else {
        for (const q of added) {
          const anim = new Animated.Value(0);
          entranceAnims.current.set(q.question_id, anim);
          Animated.timing(anim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }).start(() => {
            entranceAnims.current.delete(q.question_id);
          });
        }
      }
    }

    if (allRemoved.length === 0) return;

    // Adjust scroll position
    if (questions.length > 0 && cardWidth > 0) {
      const newIndex = Math.min(activeIndex, questions.length - 1);
      setActiveIndex(newIndex);
      setTimeout(() => {
        scrollRef.current?.scrollTo({ x: newIndex * cardWidth, animated: true });
      }, 50);
    }

    if (removed.length === 0) return;

    const newDeparting = removed.map((question) => {
      const anim = new Animated.Value(0);
      return { question, anim, phase: "entering" as const };
    });

    setDeparting((prev) => [...prev, ...newDeparting]);

    if (isWeb) {
      requestAnimationFrame(() => {
        setDeparting((prev) =>
          prev.map((d) => (d.phase === "entering" ? { ...d, phase: "leaving" } : d)),
        );
      });
      setTimeout(() => {
        const removedIds = new Set(removed.map((q) => q.question_id));
        setDeparting((prev) => prev.filter((p) => !removedIds.has(p.question.question_id)));
      }, 350);
    } else {
      for (const d of newDeparting) {
        Animated.timing(d.anim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          setDeparting((prev) => prev.filter((p) => p.question.question_id !== d.question.question_id));
        });
      }
    }
  }, [questions]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = questions.length;
  const hasDeparting = departing.length > 0;

  const displayCount = count || departing.length;
  const clampedIndex = Math.min(activeIndex, Math.max(count - 1, 0));

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

  // Nothing to show
  if (count === 0 && !hasDeparting) return null;

  const prevPath = count > 0 && clampedIndex > 0 ? shortenPath(questions[clampedIndex - 1].cwd) : null;
  const nextPath = count > 0 && clampedIndex < count - 1 ? shortenPath(questions[clampedIndex + 1].cwd) : null;

  const renderDepartingCard = (d: DepartingQuestion) => {
    const card = (
      <NotificationCard
        question={d.question}
        resolvedJob={resolveJob(d.question)}
        onNavigate={onNavigate}
        onSendOption={wrappedOnSendOption}
        autoYesActive={autoYesPaneIds?.has(d.question.pane_id)}
        onToggleAutoYes={onToggleAutoYes}
        autoAnswered={autoAnsweredIds?.has(d.question.question_id)}
      />
    );

    if (isWeb) {
      const isLeaving = d.phase === "leaving";
      return (
        <div
          key={d.question.question_id}
          style={{
            transition: "opacity 300ms ease, transform 300ms ease",
            opacity: isLeaving ? 0 : 1,
            transform: isLeaving ? "translateX(400px) scale(0.8)" : "translateX(0) scale(1)",
          }}
        >
          {card}
        </div>
      );
    }

    return (
      <Animated.View
        key={d.question.question_id}
        style={{
          opacity: d.anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [
            { translateX: d.anim.interpolate({ inputRange: [0, 1], outputRange: [0, 400] }) },
            { scale: d.anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.8] }) },
          ],
        }}
      >
        {card}
      </Animated.View>
    );
  };

  // If only departing cards remain, show the fly-away animation
  if (count === 0 && hasDeparting) {
    return (
      <View style={styles.container}>
        <View>{departing.map(renderDepartingCard)}</View>
      </View>
    );
  }

  const renderQuestionCard = (q: ClaudeQuestion) => {
    const inner = (
      <NotificationCard
        question={q}
        resolvedJob={resolveJob(q)}
        onNavigate={onNavigate}
        onSendOption={wrappedOnSendOption}
        autoYesActive={autoYesPaneIds?.has(q.pane_id)}
        onToggleAutoYes={onToggleAutoYes}
        autoAnswered={autoAnsweredIds?.has(q.question_id)}
      />
    );

    if (isWeb) {
      const isEntering = entering.has(q.question_id);
      return (
        <View key={q.question_id} style={{ width: cardWidth || "100%" }}>
          <div
            style={{
              transition: "opacity 300ms ease, transform 300ms ease",
              opacity: isEntering ? 0 : 1,
              transform: isEntering ? "translateX(-100px) scale(0.9)" : "translateX(0) scale(1)",
            }}
          >
            {inner}
          </div>
        </View>
      );
    }

    const entAnim = entranceAnims.current.get(q.question_id);
    return (
      <View key={q.question_id} style={{ width: cardWidth || "100%" }}>
        {entAnim ? (
          <Animated.View style={{
            opacity: entAnim,
            transform: [
              { translateX: entAnim.interpolate({ inputRange: [0, 1], outputRange: [-100, 0] }) },
              { scale: entAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
            ],
          }}>
            {inner}
          </Animated.View>
        ) : inner}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={onToggleCollapse}
        style={styles.headerRow}
        activeOpacity={0.6}
      >
        <Text style={styles.headerArrow}>
          {collapsed ? "\u25B6" : "\u25BC"}
        </Text>
        <Text style={styles.headerText}>Waiting for input ({displayCount})</Text>
      </TouchableOpacity>

      {!collapsed && (
        <View onLayout={handleLayout}>
          {count > 1 && (
            <View style={styles.navRow}>
              <TouchableOpacity
                onPress={goPrev}
                disabled={clampedIndex === 0}
                style={[styles.navBtn, styles.navBtnLeft]}
                activeOpacity={0.6}
              >
                <View style={[styles.arrowCircle, clampedIndex === 0 && styles.arrowDisabled]}>
                  <Text style={styles.arrowText}>{"\u2039"}</Text>
                </View>
                {prevPath ? <Text style={[styles.navPath, clampedIndex === 0 && styles.arrowDisabled]} numberOfLines={1}>{prevPath}</Text> : null}
              </TouchableOpacity>

              <Text style={styles.navCounter}>
                {clampedIndex + 1}/{count}
              </Text>

              <TouchableOpacity
                onPress={goNext}
                disabled={clampedIndex >= count - 1}
                style={[styles.navBtn, styles.navBtnRight]}
                activeOpacity={0.6}
              >
                {nextPath ? <Text style={[styles.navPath, clampedIndex >= count - 1 && styles.arrowDisabled]} numberOfLines={1}>{nextPath}</Text> : null}
                <View style={[styles.arrowCircle, clampedIndex >= count - 1 && styles.arrowDisabled]}>
                  <Text style={styles.arrowText}>{"\u203A"}</Text>
                </View>
              </TouchableOpacity>
            </View>
          )}

          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
          >
            {questions.map(renderQuestionCard)}
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
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  navBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  navBtnLeft: {
    justifyContent: "flex-start",
  },
  navBtnRight: {
    justifyContent: "flex-end",
  },
  navPath: {
    color: colors.textMuted,
    fontSize: 11,
    flexShrink: 1,
  },
  arrowCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  arrowDisabled: {
    opacity: 0.25,
  },
  arrowText: {
    color: colors.textSecondary,
    fontSize: 18,
    lineHeight: 20,
    marginTop: -2,
    fontWeight: "600",
  },
  navCounter: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    minWidth: 30,
  },
});
