import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import type { ClaudeQuestion } from "../types/process";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { AnsiText, hasAnsi } from "./AnsiText";
import { collapseSeparators, truncateLogLines } from "../util/logs";
import { isFreetextOption } from "../util/jobs";
import { fitPath, shortenPath } from "../util/format";

const isWeb = Platform.OS === "web";

let measureCanvas: HTMLCanvasElement | null = null;
function measureTextPx(text: string, font: string): number {
  if (!isWeb || typeof document === "undefined") return text.length * 7.4;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * 7.4;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function useFittedNotificationPath(path: string): {
  text: string;
  onLayout: (event: LayoutChangeEvent) => void;
} {
  const [width, setWidth] = useState(0);
  const [text, setText] = useState(() => shortenPath(path));

  useEffect(() => {
    const font = "500 15px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    setText(fitPath(path, width, (candidate) => measureTextPx(candidate, font)));
  }, [path, width]);

  return {
    text,
    onLayout: (event: LayoutChangeEvent) => {
      const nextWidth = event.nativeEvent.layout.width;
      setWidth((prev) => (Math.abs(prev - nextWidth) > 1 ? nextWidth : prev));
    },
  };
}

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
  /** Override the auto-reset delay (ms) for the "Sent" indicator. Default: 10000 */
  answerResetMs?: number;
  cardMinHeight?: number;
  onOptionScrollBegin?: () => void;
  onOptionScrollEnd?: () => void;
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
  answerResetMs = 10000,
  cardMinHeight,
  onOptionScrollBegin,
  onOptionScrollEnd,
}: NotificationCardProps) {
  const { width } = useWindowDimensions();
  const [answered, setAnswered] = useState(false);
  const prevQuestionId = useRef(question.question_id);
  const flyAnim = useRef(new Animated.Value(0)).current;
  const webCardHeight = useRef(0);
  const previewScrollRef = useRef<ScrollView>(null);

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
    }, answerResetMs);
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

  const handleOptionPress = (optionNumber: string, label: string) => {
    // "Type something" options need freetext input - navigate to detail view
    if (isFreetextOption(label)) {
      onNavigate(question, resolvedJob);
      return;
    }
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

  const fittedPath = useFittedNotificationPath(question.cwd);
  const title = resolvedJob ? resolvedJob : fittedPath.text;

  const preview = truncateLogLines(collapseSeparators(question.context_lines).trim(), 160);
  const cardSizeStyle = cardMinHeight
    ? { minHeight: cardMinHeight, maxHeight: cardMinHeight }
    : null;
  const maxButtonWidth = Math.min(520, Math.max(240, Math.floor(width * 0.66)));

  const optionControls = (
    <>
      {question.options.map((opt) => (
        <TouchableOpacity
          key={opt.number}
          style={styles.optionBtn}
          onPress={() => handleOptionPress(opt.number, opt.label)}
          activeOpacity={0.6}
        >
          <Text style={styles.optionBtnText} numberOfLines={2}>
            {question.input_mode === "select" ? opt.label : `${opt.number}. ${opt.label}`}
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
            <Text style={styles.autoYesBtnText} numberOfLines={2}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </>
  );
  const answerOptionControls = question.options.map((opt) => (
    <TouchableOpacity
      key={opt.number}
      style={[
        styles.optionBtn,
        !isWeb && styles.optionBtnNative,
        !isWeb && opt.label.length > 18 && { width: maxButtonWidth },
      ]}
      onPress={() => handleOptionPress(opt.number, opt.label)}
      activeOpacity={0.6}
    >
      <Text style={[styles.optionBtnText, !isWeb && styles.optionBtnTextNative]} numberOfLines={2}>
        {question.input_mode === "select" ? opt.label : `${opt.number}. ${opt.label}`}
      </Text>
    </TouchableOpacity>
  ));
  const optionArea = isWeb ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.optionRow}
      contentContainerStyle={styles.optionRowContent}
    >
      {optionControls}
    </ScrollView>
  ) : (
    <View style={[styles.optionRow, styles.optionRowNative]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        nestedScrollEnabled
        style={styles.answerOptionsNative}
        contentContainerStyle={styles.answerOptionsNativeContent}
        onScrollBeginDrag={onOptionScrollBegin}
        onScrollEndDrag={onOptionScrollEnd}
        onMomentumScrollEnd={onOptionScrollEnd}
      >
        {answerOptionControls}
      </ScrollView>
      {onToggleAutoYes && (
        <TouchableOpacity
          style={[styles.autoYesBtn, styles.autoYesBtnNative, autoYesActive && styles.autoYesBtnActive]}
          onPress={() => onToggleAutoYes(question)}
          activeOpacity={0.6}
        >
          <Text style={[styles.autoYesBtnText, styles.autoYesBtnTextNative]} numberOfLines={1}>
            {autoYesActive ? "Auto-yes on" : "Yes to all"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
  const previewContent = hasAnsi(preview) ? (
    <AnsiText content={preview} style={styles.logText} />
  ) : (
    <Text style={styles.logText}>{preview}</Text>
  );

  const cardContent = (
    <>
      <TouchableOpacity
        style={styles.cardBody}
        onPress={() => onNavigate(question, resolvedJob)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <Text
            style={styles.cardTitle}
            numberOfLines={1}
            ellipsizeMode={resolvedJob ? "tail" : "head"}
            onLayout={resolvedJob ? undefined : fittedPath.onLayout}
          >
            {title}
          </Text>
          <View style={styles.headerRight}>
            <Text style={styles.openText}>Open</Text>
            <Text style={styles.chevron}>{"\u203A"}</Text>
          </View>
        </View>

        {preview ? (
          <ScrollView
            ref={previewScrollRef}
            style={styles.logPreview}
            contentContainerStyle={styles.logPreviewContent}
            nestedScrollEnabled
            onContentSizeChange={() => previewScrollRef.current?.scrollToEnd({ animated: false })}
          >
            {previewContent}
          </ScrollView>
        ) : null}
      </TouchableOpacity>

      {question.options.length > 0 && (
        showAnswered ? (
          <View style={styles.sentRow}>
            <ActivityIndicator size="small" color={autoAnswered ? colors.warning : colors.accent} />
            <Text style={styles.sentText}>{autoAnswered ? "Auto-accepted" : "Sent"}</Text>
          </View>
        ) : (
          optionArea
        )
      )}
    </>
  );

  if (isWeb) {
    // For the last card, no fly-away - the section wrapper handles the collapse
    if (isLast) {
      return <View style={[styles.card, cardSizeStyle]}>{cardContent}</View>;
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
        <View style={[styles.card, cardSizeStyle]}>{cardContent}</View>
      </div>
    );
  }

  if (isLast) {
    return <View style={[styles.card, cardSizeStyle]}>{cardContent}</View>;
  }

  return (
    <Animated.View
      style={[
        styles.card,
        cardSizeStyle,
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
    minHeight: 180,
    maxHeight: 520,
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
    flex: 1,
    minWidth: 0,
    marginRight: spacing.sm,
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
  logPreviewContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
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
  },
  optionRowNative: {
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  answerOptionsNative: {
    width: "100%",
  },
  answerOptionsNativeContent: {
    flexDirection: "row",
    gap: 8,
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
    maxWidth: 280,
  },
  optionBtnNative: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accentBg,
  },
  optionBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  optionBtnTextNative: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
    textAlign: "center",
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
  autoYesBtnNative: {
    minHeight: 44,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 999,
  },
  autoYesBtnActive: {
    backgroundColor: colors.warningBg,
  },
  autoYesBtnText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
  },
  autoYesBtnTextNative: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "700",
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
