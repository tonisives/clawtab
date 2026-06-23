import { Platform, View } from "react-native";

import type { ShellPane } from "../../types/process";
import { spacing } from "../../theme/spacing";
import { ShellCard } from "../ShellCard";
import type { JobListViewHook } from "./useJobListView";

interface JobListShellItemProps {
  hook: JobListViewHook;
  shell: ShellPane;
  itemKey: string;
  index: number;
}

export function JobListShellItem({ hook, shell, itemKey, index }: JobListShellItemProps) {
  const onPress = hook.onSelectShell ? () => hook.onSelectShell?.(shell) : undefined;
  const keyId = `_term_${shell.pane_id}`;
  const rawColor = hook.selectedItems?.get(keyId);
  const isFocused = !hook.focusedItemKey || hook.focusedItemKey === keyId;
  const selected: boolean | string = rawColor
    ? (isFocused ? rawColor : rawColor + "66")
    : (hook.selectedSlug === keyId);
  const onStop = hook.onStopShell ? () => hook.onStopShell?.(shell.pane_id) : undefined;
  const onRename = hook.onRenameShell ? () => hook.onRenameShell?.(shell) : undefined;
  const openElsewhere = hook.openElsewhereContentKeys?.has(`term:${shell.pane_id}`) ?? false;
  const softBorder = openElsewhere && !selected;

  return (
    <View
      key={itemKey}
      {...(Platform.OS === "web" ? { dataSet: { shellId: shell.pane_id } } : {})}
      style={Platform.OS === "web" && index > 0 ? { marginTop: spacing.sm } : undefined}
    >
      {hook.customRenderShellCard
        ? hook.customRenderShellCard({ shell, onPress, selected, softBorder, onStop, onRename, renameShortcutHint: hook.renameShortcutHint })
        : <ShellCard shell={shell} onPress={onPress} selected={selected} softBorder={softBorder} onStop={onStop} onRename={onRename} renameShortcutHint={hook.renameShortcutHint} />
      }
    </View>
  );
}
