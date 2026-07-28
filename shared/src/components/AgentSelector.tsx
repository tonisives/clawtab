import { useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";
import type { AgentEffort, AgentModelOption, AgentSelection, ProcessProvider } from "../types/process";
import { AGENT_EFFORT_OPTIONS, defaultAgentEffort, isSyntheticAgentModel } from "../types/process";
import { agentSelectionLabel, labelForProvider, modelPickerLabel } from "../util/agent";
import { JobKindIcon } from "./JobKindIcon";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";

export type AgentSelectorProps = {
  modelOptions?: AgentModelOption[];
  provider?: ProcessProvider | null;
  model?: string | null;
  effort?: AgentEffort | null;
  onChange: (selection: AgentSelection) => void | Promise<void>;
  includeDefault?: boolean;
  onSelectDefault?: () => void | Promise<void>;
  includeShell?: boolean;
  defaultLabel?: string;
  mode?: "plus" | "button";
  label?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  nativeBottomInset?: number;
};

export function AgentSelector({
  modelOptions = [],
  provider,
  model,
  effort,
  onChange,
  includeDefault = false,
  onSelectDefault,
  includeShell = false,
  defaultLabel = "Default",
  mode = "button",
  label,
  disabled = false,
  fullWidth = false,
  nativeBottomInset = 88,
}: AgentSelectorProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [stage, setStage] = useState<"model" | "effort">("model");
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pending, setPending] = useState<{ provider: ProcessProvider; modelId: string | null; defaultEffort: AgentEffort | null } | null>(null);
  const buttonRef = useRef<any>(null);

  const resetMenu = useCallback(() => {
    setMenuOpen(false);
    setStage("model");
    setPending(null);
  }, []);

  const openMenu = useCallback((event: any) => {
    if (disabled) return;
    if (menuOpen) {
      resetMenu();
      return;
    }
    if (Platform.OS === "web") {
      const node = event?.currentTarget ?? event?.target;
      const rect = node?.getBoundingClientRect?.();
      if (rect) setMenuPos({ top: rect.bottom + 6, left: rect.right });
      setMenuOpen(true);
      return;
    }
    if (buttonRef.current?.measureInWindow) {
      buttonRef.current.measureInWindow((x: number, y: number, _width: number, height: number) => {
        setMenuPos({ top: y + height + 6, left: x });
        setMenuOpen(true);
      });
      return;
    }
    setMenuOpen(true);
  }, [disabled, menuOpen, resetMenu]);

  const chooseModel = useCallback((nextProvider: ProcessProvider, nextModel: string | null) => {
    if (nextProvider === "shell") {
      resetMenu();
      void onChange({ provider: nextProvider, modelId: nextModel, effort: null });
      return;
    }
    setPending({
      provider: nextProvider,
      modelId: nextModel,
      defaultEffort: defaultAgentEffort(nextProvider, nextModel),
    });
    setStage("effort");
    setMenuOpen(true);
  }, [onChange, resetMenu]);

  const chooseEffort = useCallback((nextEffort: AgentEffort) => {
    if (!pending) return;
    const selection: AgentSelection = {
      provider: pending.provider,
      modelId: pending.modelId,
      effort: nextEffort,
    };
    resetMenu();
    void onChange(selection);
  }, [onChange, pending, resetMenu]);

  const modelItems: PopupMenuItem[] = [];
  if (includeDefault) {
    modelItems.push({
      type: "item",
      label: defaultLabel,
      active: provider == null && model == null && effort == null,
      onPress: () => {
        resetMenu();
        void onSelectDefault?.();
      },
    });
    if (modelOptions.length > 0 || includeShell) modelItems.push({ type: "separator" });
  }

  modelOptions
    .filter((option) => option.provider !== "shell" && !isSyntheticAgentModel(option.modelId))
    .forEach((option) => {
      modelItems.push({
        type: "item",
        label: modelPickerLabel(option.modelId, option.label),
        hint: labelForProvider(option.provider),
        active: provider === option.provider && (model ?? null) === option.modelId,
        icon: <JobKindIcon kind={option.provider} size={16} compact bare />,
        onPress: () => chooseModel(option.provider, option.modelId),
      });
    });

  if (includeShell) {
    if (modelItems.length > 0 && modelItems[modelItems.length - 1]?.type !== "separator") {
      modelItems.push({ type: "separator" });
    }
    modelItems.push({
      type: "item",
      label: "Terminal",
      hint: labelForProvider("shell"),
      active: provider === "shell",
      icon: <JobKindIcon kind="shell" size={16} compact bare />,
      onPress: () => chooseModel("shell", null),
    });
  }

  const effortItems: PopupMenuItem[] = AGENT_EFFORT_OPTIONS.map((option) => ({
    type: "item" as const,
    label: option.label,
    color: option.color,
    active: effort === option.value || (stage === "effort" && pending?.defaultEffort === option.value),
    icon: <View style={[styles.effortDot, { backgroundColor: option.color }]} />,
    onPress: () => chooseEffort(option.value),
  }));

  const hasSelection = provider != null || model != null || effort != null;
  const buttonLabel = hasSelection
    ? agentSelectionLabel(provider, model, effort)
    : (label ?? (includeDefault ? defaultLabel : "Choose agent"));

  return (
    <View style={[styles.wrap, fullWidth && styles.fullWidth]}>
      <TouchableOpacity
        ref={buttonRef}
        onPress={openMenu}
        disabled={disabled}
        style={[
          mode === "plus" ? styles.plusButton : styles.button,
          fullWidth && styles.buttonFullWidth,
          disabled && styles.disabled,
        ]}
        activeOpacity={0.65}
        hitSlop={mode === "plus" ? { top: 6, bottom: 6, left: 6, right: 6 } : undefined}
      >
        {mode === "plus" ? (
          <Text style={styles.plusText}>+</Text>
        ) : (
          <>
            <Text style={styles.buttonText} numberOfLines={1}>{buttonLabel}</Text>
            <Text style={styles.chevron}>{"\u25BE"}</Text>
          </>
        )}
      </TouchableOpacity>
      {menuOpen && (
        <PopupMenu
          items={stage === "model" ? modelItems : effortItems}
          position={menuPos}
          onClose={resetMenu}
          triggerRef={buttonRef}
          initialHighlight={false}
          nativeBottomInset={nativeBottomInset}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
  },
  fullWidth: {
    flex: 1,
  },
  plusButton: {
    width: Platform.OS === "web" ? 28 : 34,
    height: Platform.OS === "web" ? 28 : 34,
    borderRadius: 999,
    backgroundColor: colors.groupedSurface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  plusText: {
    color: colors.textSecondary,
    fontSize: Platform.OS === "web" ? 18 : 22,
    lineHeight: Platform.OS === "web" ? 20 : 24,
    fontWeight: "400",
  },
  button: {
    minHeight: 36,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.groupedSurface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonFullWidth: {
    justifyContent: "space-between",
  },
  buttonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 9,
  },
  effortDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  disabled: {
    opacity: 0.45,
  },
});
