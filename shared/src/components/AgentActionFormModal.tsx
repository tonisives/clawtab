import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useEffect, useState } from "react";
import type { AgentActionDescriptor, AgentActionParameter } from "../types/agentPlugin";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export type AgentActionFormModalProps = {
  action: AgentActionDescriptor | null;
  visible: boolean;
  onClose: () => void;
  onSubmit: (parameters: Record<string, string>) => void;
  submitting?: boolean;
};

type AgentActionFieldProps = {
  parameter: AgentActionParameter;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
};

const initializeParameterValues = (action: AgentActionDescriptor | null): Record<string, string> => (
  action?.parameters.reduce<Record<string, string>>((values, parameter) => ({
    ...values,
    [parameter.name]: parameter.default_value ?? (parameter.kind === "boolean" ? "false" : ""),
  }), {}) ?? {}
);

const supportsOptions = (kind: AgentActionParameter["kind"]): boolean => (
  kind === "choice" || kind === "model" || kind === "effort"
);

const AgentActionField = ({ parameter, value, invalid, disabled, onChange }: AgentActionFieldProps) => {
  const hasOptions = supportsOptions(parameter.kind) && parameter.options.length > 0;

  return (
    <View style={styles.field}>
      <View style={styles.fieldHeader}>
        <Text style={styles.fieldTitle}>
          {parameter.title}{parameter.required ? " *" : ""}
        </Text>
        {parameter.description ? (
          <Text style={styles.fieldDescription}>{parameter.description}</Text>
        ) : null}
      </View>

      {parameter.kind === "boolean" ? (
        <View style={styles.booleanRow}>
          <Text style={styles.booleanValue}>{value === "true" ? "Enabled" : "Disabled"}</Text>
          <Switch
            value={value === "true"}
            onValueChange={(nextValue) => onChange(nextValue ? "true" : "false")}
            disabled={disabled}
            trackColor={{ false: colors.borderLight, true: colors.accent }}
            thumbColor={colors.surface}
            ios_backgroundColor={colors.borderLight}
            accessibilityLabel={parameter.title}
          />
        </View>
      ) : hasOptions ? (
        <View style={styles.options}>
          {parameter.options.map((option) => (
            <Pressable
              key={option}
              style={[styles.optionButton, value === option && styles.selectedOptionButton, disabled && styles.disabledButton]}
              onPress={() => onChange(option)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ disabled, selected: value === option }}
            >
              <Text style={[styles.optionText, value === option && styles.selectedOptionText]}>{option}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <TextInput
          style={[styles.textInput, invalid && styles.invalidInput]}
          value={value}
          onChangeText={onChange}
          placeholder={parameter.placeholder}
          placeholderTextColor={colors.textMuted}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={parameter.title}
        />
      )}

      {invalid ? <Text style={styles.errorText}>This field is required.</Text> : null}
    </View>
  );
};

export const AgentActionFormModal = ({ action, visible, onClose, onSubmit, submitting = false }: AgentActionFormModalProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setValues(initializeParameterValues(action));
    setSubmitted(false);
  }, [action?.id, visible]);

  const updateValue = (name: string, value: string) => {
    setValues((currentValues) => ({ ...currentValues, [name]: value }));
  };

  const missingParameters = action?.parameters.filter((parameter) => (
    parameter.required && (
      parameter.kind === "boolean"
        ? values[parameter.name] === undefined
        : !(values[parameter.name] ?? "").trim()
    )
  )) ?? [];
  const missingParameterNames = new Set(missingParameters.map((parameter) => parameter.name));

  const handleSubmit = () => {
    if (!action || submitting) return;
    setSubmitted(true);
    if (missingParameters.length > 0) return;

    const parameters = action.parameters.reduce<Record<string, string>>((submittedValues, parameter) => {
      const value = values[parameter.name] ?? (parameter.kind === "boolean" ? "false" : "");
      if (parameter.kind === "boolean") {
        submittedValues[parameter.name] = value === "true" ? "true" : "false";
      } else if (value.trim()) {
        submittedValues[parameter.name] = value;
      }
      return submittedValues;
    }, {});
    onSubmit(parameters);
  };

  if (!action) return null;

  const content = (
    <View style={styles.root}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} disabled={submitting} />
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>{action.title}</Text>
            {action.plugin_name ? <Text style={styles.pluginName} numberOfLines={1}>{action.plugin_name}</Text> : null}
          </View>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Close agent action form"
            hitSlop={8}
          >
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {action.description ? <Text style={styles.description}>{action.description}</Text> : null}
          {action.parameters.map((parameter) => (
            <AgentActionField
              key={parameter.name}
              parameter={parameter}
              value={values[parameter.name] ?? (parameter.kind === "boolean" ? "false" : "")}
              invalid={submitted && missingParameterNames.has(parameter.name)}
              disabled={submitting}
              onChange={(value) => updateValue(parameter.name, value)}
            />
          ))}
          {submitted && missingParameters.length > 0 ? (
            <Text style={styles.formError}>Complete the required fields before running this action.</Text>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable style={styles.secondaryButton} onPress={onClose} disabled={submitting}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryButton, submitting && styles.disabledButton]}
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>{submitting ? "Running..." : "Run action"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  if (Platform.OS !== "web") {
    if (!visible) return null;
    return <View style={styles.nativeRoot}>{content}</View>;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {content}
    </Modal>
  );
};

const styles = StyleSheet.create({
  nativeRoot: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2000,
    elevation: 2000,
  },
  root: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "86%",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  pluginName: {
    color: colors.textMuted,
    fontSize: 11,
  },
  closeButton: {
    minHeight: 32,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: spacing.md,
  },
  close: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  scroll: {
    flexGrow: 0,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  description: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  field: {
    gap: spacing.xs,
  },
  fieldHeader: {
    gap: 2,
  },
  fieldTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  fieldDescription: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  textInput: {
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    fontSize: 13,
  },
  invalidInput: {
    borderColor: colors.danger,
  },
  booleanRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  booleanValue: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  optionButton: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  selectedOptionButton: {
    borderColor: colors.accent,
    backgroundColor: colors.accentBg,
  },
  optionText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  selectedOptionText: {
    color: colors.accent,
    fontWeight: "600",
  },
  errorText: {
    color: colors.danger,
    fontSize: 11,
  },
  formError: {
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  secondaryButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  primaryButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.45,
  },
});
