import { View, Text, TouchableOpacity, ScrollView } from "react-native";
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

export function OptionButtons({ options, onSend, onFreetextOption, autoYesActive, onToggleAutoYes }: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
}) {
  if (options.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.optionBar}
      contentContainerStyle={styles.optionBarContent}
    >
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.number}
          style={styles.optionBtn}
          onPress={() => {
            if (isFreetextOption(opt.label) && onFreetextOption) {
              onFreetextOption(opt.number);
            } else {
              onSend(opt.number);
            }
          }}
          activeOpacity={0.6}
        >
          <Text style={styles.optionBtnText}>
            {opt.number}. {opt.label.length > 25 ? opt.label.slice(0, 25) + "..." : opt.label}
          </Text>
        </TouchableOpacity>
      ))}
      {onToggleAutoYes && (
        <>
          <View style={styles.optionSeparator} />
          <TouchableOpacity
            style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
            onPress={onToggleAutoYes}
            activeOpacity={0.6}
          >
            <Text style={styles.autoYesBtnText} numberOfLines={1}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}
