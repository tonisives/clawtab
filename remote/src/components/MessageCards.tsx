import { useState } from "react"
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useRouter } from "expo-router"
import { colors, spacing, messageKind, messageNeedsReply, messagePending, type MessageRecord } from "@clawtab/shared"
import { questionMessage, useMessageStore } from "../store/messages"
import { useNotificationStore } from "../store/notifications"
import { messageAction } from "../lib/messageActions"
import { notificationJobRoute, notificationProcessRoute } from "../lib/notificationRoutes"
import type { NotificationDetailTarget } from "./notificationTypes"

type Navigation = { onSelectDetail?: (target: NotificationDetailTarget) => void; onNavigateAway?: () => void }

function MessageCard({ record, onSelectDetail, onNavigateAway }: { record: MessageRecord } & Navigation) {
  const router = useRouter()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const pending = messagePending(record)
  const reply = messageNeedsReply(record)
  const act = async (action?: string) => {
    setBusy(true); setNotice("")
    try {
      await messageAction({ machine: record.machine_id, id: record.id, op: action ? "respond" : "dismiss", action_id: action, ...(action === "reply" ? { text: text.trim() } : {}) })
      if (messagePending(useMessageStore.getState().records.find(item => item.id === record.id && item.machine_id === record.machine_id) ?? record)) setNotice("Saved. Waiting for connection.")
      else setText("")
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  const source = record.request.source
  const open = () => {
    if (onSelectDetail) {
      onSelectDetail(source.pane_id ? { kind: "process", paneId: source.pane_id } : { kind: "job", jobName: source.job_id! })
    } else {
      onNavigateAway?.()
      router.push(source.pane_id ? notificationProcessRoute(source.pane_id) : notificationJobRoute(source.job_id!))
    }
  }
  return <View style={styles.card}>
    <Text style={styles.kind}>{messageKind(record)}{pending ? "" : ` · ${record.dismissed_at ? "dismissed" : record.status}`}</Text>
    <Text style={styles.title}>{record.request.title}</Text>
    {!!record.request.body && record.request.body !== record.request.title && <Text selectable style={styles.body}>{record.request.body}</Text>}
    {record.request.media?.filter(media => media.src.startsWith("https://")).map((media, index) => <View key={index}>
      {media.kind === "image" && <Image source={{ uri: media.src }} accessibilityLabel={media.alt} style={styles.image} resizeMode="contain" />}
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(media.src)}><Text style={styles.link}>{media.alt || `Open ${media.kind}`}</Text></Pressable>
    </View>)}
    {pending && reply && <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
        {record.request.actions.filter(action => action.kind === "choice").map(action => <Pressable key={action.id} accessibilityRole="button" disabled={busy || record.status === "delivering"} style={styles.button} onPress={() => void act(action.id)}><Text style={styles.buttonText}>{action.label}</Text></Pressable>)}
      </ScrollView>
      <TextInput accessibilityLabel="Reply" placeholder="Your reply" placeholderTextColor={colors.textMuted} multiline value={text} onChangeText={setText} editable={!busy} style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy || !text.trim() || record.status === "delivering"} style={[styles.button, (!text.trim() || busy) && styles.disabled]} onPress={() => void act("reply")}><Text style={styles.buttonText}>{busy ? "Sending…" : "Send reply"}</Text></Pressable>
    </>}
    {!!(notice || record.error) && <Text accessibilityRole="alert" style={styles.notice}>{notice || record.error}</Text>}
    <View style={styles.actions}>
      {!!(source.pane_id || source.job_id) && <Pressable accessibilityRole="button" onPress={open}><Text style={styles.link}>{source.pane_id ? "Open agent" : "Open job"}</Text></Pressable>}
      {pending && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act()}><Text style={styles.link}>{reply ? "Dismiss" : "Got it"}</Text></Pressable>}
    </View>
  </View>
}

export function MessageCards(navigation: Navigation) {
  const records = useMessageStore(state => state.records)
  const questions = useNotificationStore(state => state.questions)
  const [history, setHistory] = useState(false)
  const represented = new Set(questions.map(question => questionMessage(records, question)?.id))
  const pending = records.filter(record => messagePending(record) && !represented.has(record.id))
  const previous = records.filter(record => !messagePending(record)).slice(0, 30)
  return <View style={styles.container}>
    {pending.map(record => <MessageCard key={`${record.machine_id}:${record.id}`} record={record} {...navigation} />)}
    {previous.length > 0 && <Pressable accessibilityRole="button" onPress={() => setHistory(!history)}><Text style={styles.link}>{history ? "Hide history" : "Message history"}</Text></Pressable>}
    {history && previous.map(record => <MessageCard key={`${record.machine_id}:${record.id}`} record={record} {...navigation} />)}
  </View>
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: spacing.md, gap: spacing.sm },
  kind: { color: colors.textMuted, fontSize: 12, textTransform: "capitalize" },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  body: { color: colors.text, fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignSelf: "flex-start" },
  buttonText: { color: colors.text, fontSize: 14 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, color: colors.text, minHeight: 64 },
  link: { color: colors.textMuted, fontSize: 13, paddingVertical: 6 },
  notice: { color: colors.warning, fontSize: 13 },
  disabled: { opacity: 0.5 },
  image: { width: "100%", height: 180 },
})
