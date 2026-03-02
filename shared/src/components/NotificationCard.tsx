import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { ClaudeQuestion } from "../types/process";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { AnsiText, hasAnsi } from "./AnsiText";
import { collapseSeparators, truncateLogLines } from "../util/logs";

const isWeb = Platform.OS === "web";

export interface NotificationCardProps {
  question: ClaudeQuestion;
  resolvedJob: string | null;
  onNavigate: (question: ClaudeQuestion, resolvedJob: string | null) => void;
  onSendOption: (question: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: (question: ClaudeQuestion) => void;
  /** Card was auto-answered - show briefly then dismiss */
  autoAnswered?: boolean;
  /** Called when the card starts its fly-away animation (web only) */
  onFlyStart?: () => void;
  /** True when this is the only card - skip fly-away, just collapse section */
  isLast?: boolean;
}

export function NotificationCard({
  question,
  resolvedJob,
  onNavigate,
  onSendOption,
  autoYesActive,
  onToggleAutoYes,
  autoAnswered,
  onFlyStart,
  isLast,
}: NotificationCardProps) {
  const [answered, setAnswered] = useState(false);
  const prevQuestionId = useRef(question.question_id);
  const flyAnim = useRef(new Animated.Value(0)).current;
  const webCardHeight = useRef(0);

  // Reset answered state when question changes
  useEffect(() => {
    if (question.question_id !== prevQuestionId.current) {
      prevQuestionId.current = question.question_id;
      setAnswered(false);
      setFlying(false);
      flyAnim.setValue(0);
    }
  }, [question.question_id, flyAnim]);

  // Auto-reset after 10s so buttons re-appear if question persists
  useEffect(() => {
    if (!answered) return;
    const timer = setTimeout(() => {
      setAnswered(false);
      setFlying(false);
      flyAnim.setValue(0);
    }, 10000);
    return () => clearTimeout(timer);
  }, [answered, flyAnim]);

  // Web: track "flying" state for CSS transition (after 400ms delay)
  const [flying, setFlying] = useState(false);

  useEffect(() => {
    if (!answered || !isWeb) return;
    // For the last card, skip fly-away - just trigger section collapse after brief "Sent" display
    if (isLast) {
      const timer = setTimeout(() => {
        onFlyStart?.();
      }, 400);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setFlying(true);
      onFlyStart?.();
    }, 400);
    return () => clearTimeout(timer);
  }, [answered]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOptionPress = (optionNumber: string) => {
    onSendOption(question, resolvedJob, optionNumber);
    setAnswered(true);
    setFlying(false);
    if (!isWeb && !isLast) {
      Animated.timing(flyAnim, {
        toValue: 1,
        duration: 300,
        delay: 400,
        useNativeDriver: true,
      }).start();
    }
  };

  const showAnswered = answered || autoAnswered;

  const title = resolvedJob
    ? resolvedJob
    : question.cwd.replace(/^\/Users\/[^/]+/, "~");

  const preview = truncateLogLines(collapseSeparators(question.context_lines).trim(), 80);

  const cardContent = (
    <>
      <TouchableOpacity
        style={styles.cardBody}
        onPress={() => onNavigate(question, resolvedJob)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
          <View style={styles.headerRight}>
            <Text style={styles.openText}>Open</Text>
            <Text style={styles.chevron}>{"\u203A"}</Text>
          </View>
        </View>

        {preview ? (
          <View style={styles.logPreview}>
            {hasAnsi(preview) ? (
              <AnsiText content={preview} style={styles.logText} />
            ) : (
              <Text style={styles.logText}>{preview}</Text>
            )}
          </View>
        ) : null}
      </TouchableOpacity>

      {question.options.length > 0 && (
        showAnswered ? (
          <View style={styles.sentRow}>
            <ActivityIndicator size="small" color={autoAnswered ? colors.warning : colors.accent} />
            <Text style={styles.sentText}>{autoAnswered ? "Auto-accepted" : "Sent"}</Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.optionRow}
            contentContainerStyle={styles.optionRowContent}
          >
            {question.options.map((opt) => (
              <TouchableOpacity
                key={opt.number}
                style={styles.optionBtn}
                onPress={() => handleOptionPress(opt.number)}
                activeOpacity={0.6}
              >
                <Text style={styles.optionBtnText} numberOfLines={1}>
                  {opt.number}. {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
            {onToggleAutoYes && (
              <>
                <View style={styles.separator} />
                <TouchableOpacity
                  style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
                  onPress={() => onToggleAutoYes(question)}
                  activeOpacity={0.6}
                >
                  <Text style={styles.autoYesBtnText} numberOfLines={1}>
                    {autoYesActive ? "! Auto ON" : "! Yes all"}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        )
      )}
    </>
  );

  if (isWeb) {
    // For the last card, no fly-away - the section wrapper handles the collapse
    if (isLast) {
      return <View style={styles.card}>{cardContent}</View>;
    }
    return (
      <div
        ref={(el: HTMLDivElement | null) => {
          if (el && !flying) webCardHeight.current = el.offsetHeight;
        }}
        style={{
          transition: answered
            ? "opacity 300ms ease, transform 300ms ease, height 300ms ease"
            : undefined,
          opacity: flying ? 0 : 1,
          transform: flying ? "translateX(300px) scale(0.85)" : "translateX(0) scale(1)",
          height: answered ? (flying ? 0 : webCardHeight.current || undefined) : undefined,
          overflow: answered ? "hidden" : undefined,
        }}
      >
        <View style={styles.card}>{cardContent}</View>
      </div>
    );
  }

  if (isLast) {
    return <View style={styles.card}>{cardContent}</View>;
  }

  return (
    <Animated.View
      style={[
        styles.card,
        answered && {
          opacity: flyAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [
            { translateX: flyAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 300] }) },
            { scale: flyAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.85] }) },
          ],
        },
      ]}
    >
      {cardContent}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    minHeight: 120,
    overflow: "hidden",
  },
  cardBody: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  openText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 14,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  logPreview: {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: 2,
  },
  logText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
    lineHeight: 16,
  },
  optionRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    maxHeight: 44,
  },
  optionRowContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: "center",
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  separator: {
    width: 1,
    height: 18,
    backgroundColor: colors.border,
  },
  autoYesBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  autoYesBtnActive: {
    backgroundColor: colors.warningBg,
  },
  autoYesBtnText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
  },
  sentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
  },
  sentText: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
