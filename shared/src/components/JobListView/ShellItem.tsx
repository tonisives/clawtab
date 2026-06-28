import { Platform, View } from "react-native";

import type { ShellPane } from "../../types/process";
import { ShellCard } from "../ShellCard";
import type { GroupedRowPosition } from "./sign";
import type { JobListViewHook } from "./useJobListView";

interface JobListShellItemProps {
  hook: JobListViewHook;
  shell: ShellPane;
  itemKey: string;
  index: number;
  groupedPosition?: GroupedRowPosition;
}

export function JobListShellItem({ hook, shell, itemKey, groupedPosition }: JobListShellItemProps) {
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
      style={Platform.OS === "web" && groupedPosition && groupedPosition !== "single" && groupedPosition !== "first" ? { marginTop: -1 } : undefined}
    >
      {hook.customRenderShellCard
        ? hook.customRenderShellCard({ shell, onPress, selected, softBorder, onStop, onRename, renameShortcutHint: hook.renameShortcutHint, groupedPosition })
        : <ShellCard shell={shell} onPress={onPress} selected={selected} softBorder={softBorder} onStop={onStop} onRename={onRename} renameShortcutHint={hook.renameShortcutHint} groupedPosition={groupedPosition} />
      }
    </View>
  );
}
