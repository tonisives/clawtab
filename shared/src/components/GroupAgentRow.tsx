import { useCallback, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { AgentModelOption, ProcessProvider } from "../types/process";
import { JobKindIcon } from "./JobKindIcon";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";

export function GroupAgentRow({
  onRunAgent,
  modelOptions = [],
  workDir,
}: {
  onRunAgent: (prompt: string, provider?: ProcessProvider, model?: string | null) => void | Promise<void>;
  provider?: ProcessProvider;
  providers?: ProcessProvider[];
  onProviderChange?: (provider: ProcessProvider) => void;
  model?: string | null;
  modelOptions?: AgentModelOption[];
  onModelChange?: (provider: ProcessProvider, model: string | null) => void;
  focusSignal?: number;
  workDir?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<any>(null);
  const sendingRef = useRef(false);

  const launch = useCallback(async (provider: ProcessProvider, modelId: string | null) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      await onRunAgent("", provider, modelId);
    } finally {
      sendingRef.current = false;
    }
  }, [onRunAgent]);

  const items: PopupMenuItem[] = [
    ...modelOptions
      .filter((opt) => opt.provider !== "shell")
      .map((opt) => ({
        type: "item" as const,
        label: opt.label,
        icon: <JobKindIcon kind={opt.provider} size={16} compact bare />,
        onPress: () => {
          setMenuOpen(false);
          void launch(opt.provider, opt.modelId);
        },
      })),
    { type: "separator" as const },
    {
      type: "item" as const,
      label: "Terminal",
      icon: <JobKindIcon kind="shell" size={16} compact bare />,
      onPress: () => {
        setMenuOpen(false);
        void launch("shell", null);
      },
    },
  ];

  return (
    <View
      style={styles.row}
      {...(Platform.OS === "web" && workDir ? { dataSet: { agentWorkdir: workDir } } : {})}
    >
      <TouchableOpacity
        ref={buttonRef}
        onPress={(e: any) => {
          if (Platform.OS === "web") {
            const node = e?.currentTarget ?? e?.target;
            if (node?.getBoundingClientRect) {
              const rect = node.getBoundingClientRect();
              setMenuPos({ top: rect.bottom + 6, left: rect.left });
            }
          } else if (buttonRef.current?.measureInWindow) {
            if (menuOpen) {
              setMenuOpen(false);
              return;
            }
            buttonRef.current.measureInWindow((x: number, y: number, width: number, height: number) => {
              setMenuPos({ top: y + height + 6, left: x });
              setMenuOpen(true);
            });
            return;
          }
          setMenuOpen((open) => !open);
        }}
        style={styles.addButton}
        activeOpacity={0.6}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={styles.addButtonText}>+</Text>
      </TouchableOpacity>
      {menuOpen && (
        <PopupMenu
          items={items}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          triggerRef={buttonRef}
          initialHighlight={false}
          nativeBottomInset={88}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  addButton: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400",
  },
});
