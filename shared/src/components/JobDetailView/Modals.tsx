import type { ReactNode } from "react";
import { View, Text, TouchableOpacity, Modal, SafeAreaView } from "react-native";
import type { RunRecord } from "../../types/job";
import type { ShellPane } from "../../types/process";
import { ReadOnlyXterm } from "../ReadOnlyXterm";
import { MessageInput } from "../MessageInput";
import { formatTime, formatDuration, shortenPath } from "../../util/format";
import { runStatusColor, runStatusLabel } from "../../util/status";
import { OptionButtons, QuestionContextBlock } from "./Options";
import { styles } from "./styles";
import { colors } from "../../theme/colors";
import { ActionButton } from "./ActionButton";

export function LiveRunZoomOverlay({
  run,
  pane,
  currentState,
  renderTerminal,
  onSplitRunPane,
  onClose,
}: {
  run: RunRecord;
  pane: ShellPane;
  currentState: string;
  renderTerminal: (paneId: string, tmuxSession: string) => ReactNode;
  onSplitRunPane?: (paneId: string, direction: "right" | "down") => void;
  onClose: () => void;
}) {
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);

  return (
    <View style={styles.liveRunZoomOverlay}>
      <View style={styles.liveRunZoomCard}>
        <View style={styles.zoomHeader}>
          <View style={styles.zoomHeaderLeft}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <Text style={styles.zoomHeaderLabel}>{label}</Text>
            <Text style={styles.zoomHeaderTime}>{formatTime(run.started_at)}</Text>
            <Text style={styles.zoomHeaderDuration}>{duration}</Text>
            <Text style={styles.liveRunZoomPath} numberOfLines={1}>
              {shortenPath(pane.cwd)}
            </Text>
          </View>
          {onSplitRunPane ? (
            <View style={styles.runTerminalActions}>
              <ActionButton
                label="Split Right"
                color={colors.accent}
                onPress={() => onSplitRunPane(pane.pane_id, "right")}
                compact
              />
              <ActionButton
                label="Split Down"
                color={colors.accent}
                onPress={() => onSplitRunPane(pane.pane_id, "down")}
                compact
              />
            </View>
          ) : null}
          <TouchableOpacity onPress={onClose} style={styles.zoomCloseBtn} activeOpacity={0.6}>
            <Text style={styles.zoomCloseText}>{"\u2715"}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.liveRunZoomTerminal}>
          {renderTerminal(pane.pane_id, pane.tmux_session)}
        </View>
      </View>
    </View>
  );
}

export function LogZoomModal({
  run,
  logContent,
  currentState,
  onClose,
}: {
  run: RunRecord;
  logContent: string;
  currentState: string;
  onClose: () => void;
}) {
  const color = runStatusColor(run, currentState);
  const label = runStatusLabel(run, currentState);
  const duration = formatDuration(run.started_at, run.finished_at);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.zoomModal}>
        <View style={styles.zoomHeader}>
          <View style={styles.zoomHeaderLeft}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <Text style={styles.zoomHeaderLabel}>{label}</Text>
            <Text style={styles.zoomHeaderTime}>{formatTime(run.started_at)}</Text>
            <Text style={styles.zoomHeaderDuration}>{duration}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.zoomCloseBtn} activeOpacity={0.6}>
            <Text style={styles.zoomCloseText}>{"\u2715"}</Text>
          </TouchableOpacity>
        </View>
        <ReadOnlyXterm content={logContent} borderless />
      </SafeAreaView>
    </Modal>
  );
}

export function LiveZoomModal({
  logs,
  options,
  questionContext,
  onSend,
  onFreetextOption,
  freetextOptionNumber,
  autoYesActive,
  onToggleAutoYes,
  autoYesShortcut,
  onClose,
}: {
  logs: string;
  options: { number: string; label: string }[];
  questionContext?: string;
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
  freetextOptionNumber?: string | null;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  autoYesShortcut?: string;
  onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.zoomModal}>
        <View style={styles.zoomHeader}>
          <View style={styles.zoomHeaderLeft}>
            <Text style={styles.zoomHeaderLabel}>Live Output</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.zoomCloseBtn} activeOpacity={0.6}>
            <Text style={styles.zoomCloseText}>{"\u2715"}</Text>
          </TouchableOpacity>
        </View>
        <ReadOnlyXterm content={logs} borderless />
        <QuestionContextBlock context={questionContext} />
        <OptionButtons options={options} onSend={onSend} onFreetextOption={onFreetextOption} autoYesActive={autoYesActive} onToggleAutoYes={onToggleAutoYes} autoYesShortcut={autoYesShortcut} />
        <MessageInput onSend={onSend} placeholder={freetextOptionNumber ? "Type your answer..." : "Send input to job..."} />
      </SafeAreaView>
    </Modal>
  );
}
