import { useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Dimensions,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { getWsSend, nextId } from "../hooks/useWebSocket"
import { registerRequest } from "../lib/useRequestMap"
import { confirm } from "../lib/platform"
import { colors } from "../theme/colors"
import { radius, spacing } from "../theme/spacing"
import type { ClaudeProcess } from "../types/job"

export function parseNumberedOptions(text: string): { number: string; label: string }[] {
  const lines = text.split("\n").slice(-20)
  const options: { number: string; label: string }[] = []
  for (const line of lines) {
    const match = line.match(/^[\s>›»❯▸▶]*(\d+)\.\s+(.+)/)
    if (match) options.push({ number: match[1], label: match[2].trim() })
  }
  if (options.length === 0) return options
  // Only treat as interactive prompt if output has prompt indicators
  const lower = text.toLowerCase()
  if (
    !lower.includes("enter to select") &&
    !lower.includes("to navigate") &&
    !lower.includes("esc to cancel") &&
    !lower.includes("to select")
  ) {
    return []
  }
  return options
}

export function ProcessCard({
  process,
  onScrollTo,
  forceExpanded,
  fixedHeight,
}: {
  process: ClaudeProcess
  onScrollTo?: () => void
  forceExpanded?: boolean
  fixedHeight?: number
}) {
  const [expanded, setExpanded] = useState(forceExpanded ?? false)
  const [fullscreen, setFullscreen] = useState(false)
  const [liveLogs, setLiveLogs] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const displayName = process.cwd.replace(/^\/Users\/[^/]+/, "~")
  const isExpanded = forceExpanded || expanded

  useEffect(() => {
    if (!isExpanded) {
      setLiveLogs(null)
      return
    }
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const send = getWsSend()
        if (!send) return
        const id = nextId()
        send({
          type: "get_detected_process_logs",
          id,
          tmux_session: process.tmux_session,
          pane_id: process.pane_id,
        })
        const timeout = new Promise<{ logs?: string }>((resolve) =>
          setTimeout(() => resolve({}), 5000),
        )
        const resp = await Promise.race([registerRequest<{ logs?: string }>(id), timeout])
        if (active && resp.logs != null) setLiveLogs(resp.logs)
      } finally {
        polling = false
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [isExpanded, process.pane_id, process.tmux_session])

  const logsText = liveLogs ?? process.log_lines
  const options = parseNumberedOptions(logsText)

  const handleSend = (text: string) => {
    const send = getWsSend()
    if (send && text.trim())
      send({
        type: "send_detected_process_input",
        id: nextId(),
        pane_id: process.pane_id,
        text: text.trim(),
      })
  }

  const handleToggle = () => {
    if (forceExpanded) return
    const next = !expanded
    setExpanded(next)
    if (next && onScrollTo) setTimeout(onScrollTo, 100)
  }

  const doStop = async () => {
    const send = getWsSend()
    if (!send || stopping) return
    setStopping(true)
    const id = nextId()
    send({ type: "stop_detected_process", id, pane_id: process.pane_id })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
    await Promise.race([registerRequest(id), timeout])
    setStopping(false)
  }

  const handleStop = () => {
    confirm("Stop process", `Kill the Claude process in ${displayName}?`, doStop)
  }

  return (
    <>
      <View style={[styles.processCard, fixedHeight != null && { height: fixedHeight, opacity: 1 }]}>
        <TouchableOpacity onPress={handleToggle} activeOpacity={0.7}>
          <View style={styles.processRow}>
            <View style={styles.processTypeIcon}>
              <Text style={styles.processTypeIconText}>C</Text>
            </View>
            <View style={styles.processInfo}>
              <Text style={styles.processName} numberOfLines={1}>
                {displayName}
              </Text>
              <View style={styles.processMeta}>
                <Text style={styles.processMetaText}>v{process.version}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => setFullscreen(true)}
              style={styles.expandBtn}
              hitSlop={8}
              activeOpacity={0.6}
            >
              <Ionicons name="scan-outline" size={16} color={colors.textMuted} />
            </TouchableOpacity>
            <View style={styles.processRunningBadge}>
              <Text style={styles.processRunningText}>running</Text>
            </View>
            {isExpanded && (
              <TouchableOpacity
                style={[styles.stopBtn, stopping && styles.btnDisabled]}
                onPress={handleStop}
                disabled={stopping}
                activeOpacity={0.7}
              >
                <Ionicons name="stop-circle-outline" size={14} color={colors.danger} />
                <Text style={styles.stopBtnText}>{stopping ? "Stopping..." : "Stop"}</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
        {isExpanded && (
          <ProcessInlineView logsText={logsText} options={options} onSend={handleSend} constrained={fixedHeight != null} />
        )}
      </View>
      {fullscreen && (
        <FullscreenProcessTerminal
          process={process}
          displayName={displayName}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  )
}

function ProcessInlineView({
  logsText,
  options,
  onSend,
  constrained,
}: {
  logsText: string
  options: { number: string; label: string }[]
  onSend: (text: string) => void
  constrained?: boolean
}) {
  const [text, setText] = useState("")
  const scrollRef = useRef<ScrollView>(null)
  const screenH = Dimensions.get("window").height

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false })
    }, 50)
    return () => clearTimeout(timer)
  }, [logsText])

  const handleSend = (input: string) => {
    onSend(input)
    setText("")
  }

  return (
    <View style={[styles.processInline, constrained && { flex: 1, overflow: "hidden" }]}>
      {logsText ? (
        <ScrollView
          ref={scrollRef}
          style={[styles.inlineReplyLogs, constrained ? { flex: 1 } : { maxHeight: screenH / 3 }]}
          nestedScrollEnabled
        >
          <Text style={styles.inlineReplyLogsText} selectable>
            {logsText}
          </Text>
        </ScrollView>
      ) : null}
      {options.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.optionScroll}
          contentContainerStyle={styles.optionScrollContent}
        >
          {options.map((opt) => (
            <TouchableOpacity
              key={opt.number}
              style={styles.optionBtn}
              onPress={() => handleSend(opt.number)}
              activeOpacity={0.6}
            >
              <Text style={styles.optionBtnText}>
                {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      <View style={styles.inlineReplyInput}>
        <TextInput
          style={styles.inlineReplyTextInput}
          value={text}
          onChangeText={setText}
          placeholder="Reply..."
          placeholderTextColor={colors.textMuted}
          returnKeyType="send"
          onSubmitEditing={() => handleSend(text)}
        />
        <TouchableOpacity
          style={[styles.inlineReplySendBtn, !text.trim() && styles.btnDisabled]}
          onPress={() => handleSend(text)}
          disabled={!text.trim()}
          activeOpacity={0.7}
        >
          <Text style={styles.inlineReplySendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function FullscreenProcessTerminal({
  process,
  displayName,
  onClose,
}: {
  process: ClaudeProcess
  displayName: string
  onClose: () => void
}) {
  const [logs, setLogs] = useState(process.log_lines)
  const [inputText, setInputText] = useState("")
  const [stopping, setStopping] = useState(false)
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => {
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const send = getWsSend()
        if (!send) return
        const id = nextId()
        send({
          type: "get_detected_process_logs",
          id,
          tmux_session: process.tmux_session,
          pane_id: process.pane_id,
        })
        const timeout = new Promise<{ logs?: string }>((resolve) =>
          setTimeout(() => resolve({}), 5000),
        )
        const resp = await Promise.race([registerRequest<{ logs?: string }>(id), timeout])
        if (active && resp.logs != null) setLogs(resp.logs)
      } finally {
        polling = false
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [process.pane_id, process.tmux_session])

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false })
    }, 50)
    return () => clearTimeout(timer)
  }, [logs])

  const options = parseNumberedOptions(logs)

  const handleSend = (text: string) => {
    const send = getWsSend()
    if (send && text.trim()) {
      send({
        type: "send_detected_process_input",
        id: nextId(),
        pane_id: process.pane_id,
        text: text.trim(),
      })
      setInputText("")
    }
  }

  const doStop = async () => {
    const send = getWsSend()
    if (!send || stopping) return
    setStopping(true)
    const id = nextId()
    send({ type: "stop_detected_process", id, pane_id: process.pane_id })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
    await Promise.race([registerRequest(id), timeout])
    setStopping(false)
    onClose()
  }

  const handleStop = () => {
    const name = process.cwd.replace(/^\/Users\/[^/]+/, "~")
    confirm("Stop process", `Kill the Claude process in ${name}?`, doStop)
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen">
      <View style={styles.fsContainer}>
        <View style={styles.fsHeader}>
          <TouchableOpacity onPress={onClose} style={styles.fsCloseBtn} activeOpacity={0.6}>
            <Text style={styles.fsCloseBtnText}>Close</Text>
          </TouchableOpacity>
          <Text style={styles.fsTitle} numberOfLines={1}>
            {displayName}
          </Text>
          <TouchableOpacity
            style={[styles.fsStopBtn, stopping && styles.btnDisabled]}
            onPress={handleStop}
            disabled={stopping}
            activeOpacity={0.7}
          >
            <Ionicons name="stop-circle-outline" size={14} color={colors.danger} />
            <Text style={styles.fsStopBtnText}>{stopping ? "Stopping..." : "Stop"}</Text>
          </TouchableOpacity>
          <View style={styles.processRunningBadge}>
            <Text style={styles.processRunningText}>running</Text>
          </View>
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.fsLogs}
          contentContainerStyle={styles.fsLogsContent}
        >
          <Text style={styles.fsLogsText} selectable>
            {logs}
          </Text>
        </ScrollView>
        {options.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.fsOptionBar}
            contentContainerStyle={styles.fsOptionBarContent}
          >
            {options.map((opt) => (
              <TouchableOpacity
                key={opt.number}
                style={styles.optionBtn}
                onPress={() => handleSend(opt.number)}
                activeOpacity={0.6}
              >
                <Text style={styles.optionBtnText}>
                  {opt.number}. {opt.label.length > 20 ? opt.label.slice(0, 20) + "..." : opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <View style={styles.fsInputRow}>
          <TextInput
            style={styles.fsTextInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Send input..."
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            onSubmitEditing={() => handleSend(inputText)}
          />
          <TouchableOpacity
            style={[styles.fsSendBtn, !inputText.trim() && styles.btnDisabled]}
            onPress={() => handleSend(inputText)}
            disabled={!inputText.trim()}
            activeOpacity={0.7}
          >
            <Text style={styles.fsSendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  processCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.7,
  },
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  processTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  processTypeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
    fontStyle: "italic",
  },
  processInfo: { flex: 1, gap: 2 },
  processName: { color: colors.text, fontSize: 15, fontWeight: "500", fontStyle: "italic" },
  processMeta: { flexDirection: "row", gap: spacing.sm },
  processMetaText: { color: colors.textSecondary, fontSize: 12 },
  processRunningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  processRunningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },
  processInline: { marginTop: spacing.sm },
  expandBtn: { padding: 4 },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerBg,
  },
  stopBtnText: { color: colors.danger, fontSize: 11, fontWeight: "500" },
  btnDisabled: { opacity: 0.5 },
  inlineReplyLogs: {
    backgroundColor: "#000",
    borderRadius: radius.sm,
    margin: spacing.sm,
    marginBottom: 0,
    padding: spacing.sm,
  },
  inlineReplyLogsText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontFamily: "monospace",
    lineHeight: 14,
  },
  optionScroll: { maxHeight: 44, marginHorizontal: spacing.sm },
  optionScrollContent: { gap: 6, paddingVertical: 4 },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: { color: colors.accent, fontSize: 11, fontWeight: "500" },
  inlineReplyInput: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    alignItems: "center",
  },
  inlineReplyTextInput: {
    flex: 1,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 12,
  },
  inlineReplySendBtn: {
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  inlineReplySendText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  fsContainer: { flex: 1, backgroundColor: colors.bg },
  fsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: 54,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fsCloseBtn: { paddingVertical: 4, paddingHorizontal: spacing.sm },
  fsCloseBtnText: { color: colors.accent, fontSize: 14, fontWeight: "500" },
  fsStopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerBg,
  },
  fsStopBtnText: { color: colors.danger, fontSize: 12, fontWeight: "500" },
  fsTitle: { flex: 1, color: colors.text, fontSize: 13, fontFamily: "monospace" },
  fsLogs: { flex: 1, backgroundColor: "#000" },
  fsLogsContent: { padding: spacing.md },
  fsLogsText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: "monospace",
    lineHeight: 18,
  },
  fsOptionBar: { maxHeight: 48, borderTopWidth: 1, borderTopColor: colors.border },
  fsOptionBarContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: "center",
  },
  fsInputRow: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: "center",
  },
  fsTextInput: {
    flex: 1,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    fontSize: 13,
  },
  fsSendBtn: {
    height: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  fsSendBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
})
