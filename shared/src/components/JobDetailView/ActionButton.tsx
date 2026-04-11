import { View, Text, TouchableOpacity } from "react-native";
import { JobKindIcon, kindForJob } from "../JobKindIcon";
import { styles } from "./styles";

export function ActionButton({
  label,
  color,
  onPress,
  filled,
  disabled,
  compact,
  icon,
}: {
  label: string;
  color: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
  compact?: boolean;
  icon?: "run" | ReturnType<typeof kindForJob>;
}) {
  const iconIsJobKind = icon && icon !== "run";
  return (
    <TouchableOpacity
      style={[
        styles.actionBtn,
        compact && styles.actionBtnCompact,
        (icon === "run" || iconIsJobKind) && styles.actionBtnSquare,
        filled
          ? { backgroundColor: color }
          : { borderColor: color, borderWidth: 1 },
        disabled ? { opacity: 0.6 } : undefined,
      ]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={disabled ? 1 : 0.7}
      disabled={disabled}
    >
      {icon === "run" ? (
        <View style={styles.runTriangle} />
      ) : iconIsJobKind ? (
        <JobKindIcon kind={icon} size={18} compact bare />
      ) : (
        <Text style={[styles.actionText, compact && styles.actionTextCompact, { color: filled ? "#fff" : color }]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}
