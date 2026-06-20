import { View, Text, TouchableOpacity, ScrollView, useWindowDimensions } from "react-native";
import { isFreetextOption } from "../../util/jobs";
import { styles } from "./styles";

// eslint-disable-next-line no-control-regex
const ANSI_RE_STRIP = /\x1b\[[0-9;]*[A-Za-z]/g;

export function QuestionContextBlock({ context }: { context?: string }) {
  if (!context) return null;
  const stripped = context.replace(ANSI_RE_STRIP, "").trim();
  if (!stripped) return null;
  return (
    <ScrollView style={styles.questionContext} nestedScrollEnabled>
      <Text style={styles.questionContextText}>{stripped}</Text>
    </ScrollView>
  );
}

export function OptionButtons({ options, onSend, onFreetextOption, autoYesActive, onToggleAutoYes, autoYesShortcut, bottomInset = 0 }: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  autoYesShortcut?: string;
  bottomInset?: number;
}) {
  const { width } = useWindowDimensions();
  if (options.length === 0) return null;

  const bottomPadding = Math.max(6, bottomInset + 10);
  const hasAutoYes = Boolean(onToggleAutoYes);
  const barHeight = bottomPadding + 62 + (hasAutoYes ? 54 : 0);
  const maxButtonWidth = Math.min(520, Math.max(240, Math.floor(width * 0.66)));

  return (
    <View style={[styles.optionBar, { height: barHeight, maxHeight: barHeight }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.optionAnswerScroll}
        contentContainerStyle={styles.optionBarContent}
      >
        {options.map((opt) => (
          <TouchableOpacity
            key={opt.number}
            style={[
              styles.optionBtn,
              { maxWidth: maxButtonWidth },
              opt.label.length > 18 && { width: maxButtonWidth },
            ]}
            onPress={() => {
              if (isFreetextOption(opt.label) && onFreetextOption) {
                onFreetextOption(opt.number);
              } else {
                onSend(opt.number);
              }
            }}
            activeOpacity={0.6}
          >
            <Text style={styles.optionBtnText} numberOfLines={2}>
              {opt.number}. {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      {onToggleAutoYes ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.autoYesRow}
          contentContainerStyle={[styles.autoYesRowContent, { paddingBottom: bottomPadding }]}
        >
          <TouchableOpacity
            style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
            onPress={onToggleAutoYes}
            activeOpacity={0.6}
          >
            <Text style={styles.autoYesBtnText} numberOfLines={1}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}{autoYesShortcut ? ` (${autoYesShortcut})` : ""}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <View style={{ height: bottomPadding }} />
      )}
    </View>
  );
}
