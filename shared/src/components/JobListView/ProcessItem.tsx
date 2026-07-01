import { Platform, View } from "react-native";

import type { DetectedProcess } from "../../types/process";
import { ProcessCard } from "../ProcessCard";
import { styles } from "./styles";
import type { GroupedRowPosition } from "./sign";
import type { JobListViewHook } from "./useJobListView";

interface JobListProcessItemProps {
  hook: JobListViewHook;
  process: DetectedProcess;
  itemKey: string;
  inGroup?: boolean;
  sortGroup?: string;
  childOfJobSlug?: string;
  groupedPosition?: GroupedRowPosition;
}

export function JobListProcessItem({
  hook,
  process,
  itemKey,
  inGroup,
  sortGroup,
  childOfJobSlug,
  groupedPosition,
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
  const marginTop = Platform.OS === "web" && groupedPosition && groupedPosition !== "single" && groupedPosition !== "first" ? -1 : undefined;
  const onPress = hook.onSelectProcess ? () => hook.onSelectProcess?.(process) : undefined;
  const pinKey = `process:${process.pane_id}`;
  const pinned = hook.pinnedItems?.includes(pinKey) ?? false;
  const onTogglePin = hook.onTogglePin ? () => hook.onTogglePin?.(pinKey) : undefined;
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
      onTogglePin,
      pinned,
      autoYesActive: hook.autoYesPaneIds?.has(process.pane_id) ?? false,
      marginTop,
      dataProcessId: process.pane_id,
      startRenameSignal: hook.renameProcessPaneId === process.pane_id ? hook.renameProcessSignal : undefined,
      onRenameDraftChange: (value: string | null) => hook.onProcessRenameDraftChange?.(process.pane_id, value),
      onRenameStateChange: (editing: boolean) => hook.onProcessRenameStateChange?.(process.pane_id, editing),
      renameShortcutHint: hook.renameShortcutHint,
      groupedPosition,
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
        onTogglePin={onTogglePin}
        pinned={pinned}
        autoYesActive={hook.autoYesPaneIds?.has(process.pane_id) ?? false}
        startRenameSignal={hook.renameProcessPaneId === process.pane_id ? hook.renameProcessSignal : undefined}
        onRenameDraftChange={(value) => hook.onProcessRenameDraftChange?.(process.pane_id, value)}
        onRenameStateChange={(editing) => hook.onProcessRenameStateChange?.(process.pane_id, editing)}
        renameShortcutHint={hook.renameShortcutHint}
        groupedPosition={groupedPosition}
      />
    );

  if (childOfJobSlug) {
    return (
      <View
        key={itemKey}
        style={[styles.jobChildProcess, Platform.OS === "web" && groupedPosition && groupedPosition !== "single" && groupedPosition !== "first" ? { marginTop: -1 } : undefined]}
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
