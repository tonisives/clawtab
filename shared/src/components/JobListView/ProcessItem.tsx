import { Platform, View } from "react-native";

import type { DetectedProcess } from "../../types/process";
import { spacing } from "../../theme/spacing";
import { ProcessCard } from "../ProcessCard";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListProcessItemProps {
  hook: JobListViewHook;
  process: DetectedProcess;
  itemKey: string;
  index: number;
  inGroup?: boolean;
  sortGroup?: string;
  childOfJobSlug?: string;
}

export function JobListProcessItem({
  hook,
  process,
  itemKey,
  index,
  inGroup,
  sortGroup,
  childOfJobSlug,
}: JobListProcessItemProps) {
  const terminalKey = `_term_${process.pane_id}`;
  const rawColor = hook.selectedItems?.get(process.pane_id) ?? hook.selectedItems?.get(terminalKey);
  const isFocused = !hook.focusedItemKey || hook.focusedItemKey === process.pane_id || hook.focusedItemKey === terminalKey;
  const selected: boolean | string = rawColor
    ? (isFocused ? rawColor : rawColor + "66")
    : (hook.selectedSlug === process.pane_id);
  const openElsewhere =
    (hook.openElsewhereContentKeys?.has(`proc:${process.pane_id}`) ?? false) ||
    (hook.openElsewhereContentKeys?.has(`term:${process.pane_id}`) ?? false);
  const softBorder = openElsewhere && !selected;
  const marginTop = Platform.OS === "web" && index > 0 ? spacing.sm : undefined;
  const onPress = hook.onSelectProcess ? () => hook.onSelectProcess?.(process) : undefined;
  const onStop = hook.onStopProcess ? () => hook.onStopProcess?.(process.pane_id) : undefined;
  const onRename = hook.onRenameProcess ? () => hook.onRenameProcess?.(process) : undefined;
  const onSaveName = hook.onSaveProcessName ? (name: string) => hook.onSaveProcessName?.(process, name) : undefined;
  const resolvedSortGroup = sortGroup ?? process.matched_group ?? `cwd:${process.cwd}`;
  const card = hook.customRenderProcessCard
    ? hook.customRenderProcessCard({
      process,
      sortGroup: resolvedSortGroup,
      onPress,
      inGroup,
      selected,
      softBorder,
      onStop,
      onRename,
      onSaveName,
      autoYesActive: hook.autoYesPaneIds?.has(process.pane_id) ?? false,
      marginTop,
      dataProcessId: process.pane_id,
      startRenameSignal: hook.renameProcessPaneId === process.pane_id ? hook.renameProcessSignal : undefined,
      onRenameDraftChange: (value: string | null) => hook.onProcessRenameDraftChange?.(process.pane_id, value),
      onRenameStateChange: (editing: boolean) => hook.onProcessRenameStateChange?.(process.pane_id, editing),
      renameShortcutHint: hook.renameShortcutHint,
    })
    : (
      <ProcessCard
        process={process}
        onPress={onPress}
        inGroup={inGroup}
        selected={selected}
        softBorder={softBorder}
        onStop={onStop}
        onRename={onRename}
        onSaveName={onSaveName}
        autoYesActive={hook.autoYesPaneIds?.has(process.pane_id) ?? false}
        startRenameSignal={hook.renameProcessPaneId === process.pane_id ? hook.renameProcessSignal : undefined}
        onRenameDraftChange={(value) => hook.onProcessRenameDraftChange?.(process.pane_id, value)}
        onRenameStateChange={(editing) => hook.onProcessRenameStateChange?.(process.pane_id, editing)}
        renameShortcutHint={hook.renameShortcutHint}
      />
    );

  if (childOfJobSlug) {
    return (
      <View
        key={itemKey}
        style={[styles.jobChildProcess, Platform.OS === "web" && index > 0 ? { marginTop: spacing.xs } : undefined]}
      >
        {card}
      </View>
    );
  }

  return (
    <View
      key={itemKey}
      {...(Platform.OS === "web" ? { dataSet: { processId: process.pane_id } } : {})}
      style={marginTop != null ? { marginTop } : undefined}
    >
      {card}
    </View>
  );
}
