import { useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useIsFocused } from "expo-router/react-navigation"
import { useMachines } from "@clawtab/shared"
import { colors } from "../../theme/colors"
import { useModelUsage } from "../../hooks/useModelUsage"
import type { ProviderUsageSnapshot } from "../../types/messages"
import { UsageProgressBar, parseUsagePercent } from "../UsageProgressBar"
import { SettingsPage, SettingsRow, styles } from "./SettingsPage"
import { useSettingsNavigation, useSettingsVisible } from "./navigation"

export let UsageSettings = () => {
  let state = useMachines()
  let pageFocused = useIsFocused()
  let settingsVisible = useSettingsVisible()
  let focused = pageFocused && settingsVisible
  let [selected, setSelected] = useState<string | null>(state.selected)
  let machine = state.machines.find((item) => item.id === selected)
    ?? state.machines.find((item) => item.online) ?? state.machines[0]
  let { usage, loading, error, refresh } = useModelUsage(machine?.id, focused && state.connected && !!machine?.online)
  let navigate = useSettingsNavigation()
  let openMachines = () => navigate("machines")
  let choose = (id: string) => () => setSelected(id)
  return <SettingsPage>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Machine</Text>
      <View style={styles.listGroup}>{state.machines.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: machine?.id === item.id }} onPress={choose(item.id)} style={styles.row}>
        <View style={styles.rowText}><Text style={styles.rowTitle}>{item.name}</Text><Text style={styles.rowDetail}>{item.online ? "Online" : "Offline"}</Text></View>
        {machine?.id === item.id && <Ionicons name="checkmark" size={22} color={colors.accent} />}
      </Pressable>)}</View>
      {!state.machines.length && <Text style={styles.usageEmptyText}>{state.connected ? "Add a machine to see its model usage." : "Connecting to your machines…"}</Text>}
      <View style={styles.listGroup}><SettingsRow title="Manage machines" onPress={openMachines} /></View>
    </View>
    <View style={styles.section}>
      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionTitle}>Model usage</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh model usage" hitSlop={12} disabled={loading || !state.connected || !machine?.online} onPress={refresh}><Text style={[styles.usageRefresh, (loading || !state.connected || !machine?.online) && styles.disabledText]}>{loading ? "Refreshing…" : "Refresh"}</Text></Pressable>
      </View>
      <Text style={styles.usageDescription}>Solid fill shows the elapsed week. The dotted marker shows model usage.</Text>
      {loading && !usage && <View style={styles.usageEmptyCard}><ActivityIndicator color={colors.accent} /><Text style={styles.usageEmptyText}>Loading model usage…</Text></View>}
      {error && <Text style={styles.usageEmptyText}>{error}</Text>}
      {(!state.connected || !machine?.online) && <Text style={styles.usageEmptyText}>{machine ? "Connect this machine to load its usage, or select another machine above." : "Your machines will be selectable here as soon as they connect."}</Text>}
      {usage && <View style={styles.usageCards}><MobileUsageCard title="Claude" usage={usage.claude} /><MobileUsageCard title="Codex" usage={usage.codex} /><MobileUsageCard title="Antigravity" usage={usage.antigravity} /><MobileUsageCard title="z.ai" usage={usage.zai} /></View>}
    </View>
  </SettingsPage>
}

let MobileUsageCard = ({
  title,
  usage,
}: {
  title: string
  usage: ProviderUsageSnapshot
}) => {
  const weekEntry = usage.entries.find((entry) => entry.label.toLowerCase() === "week")
  const weekPercent = usage.week_used_percent ?? parseUsagePercent(weekEntry?.value)

  return (
    <View style={styles.usageCard}>
      <View style={styles.usageCardHeader}>
        <Text style={styles.usageCardTitle}>{title}</Text>
        <Text style={styles.usageCardStatus}>{usage.status}</Text>
      </View>
      {weekPercent != null ? (
        <UsageProgressBar usagePercent={weekPercent} resetAt={usage.week_reset_at} />
      ) : (
        <Text style={styles.usageUnavailable}>{usage.summary}</Text>
      )}
      {usage.note ? <Text style={styles.usageNote}>{usage.note}</Text> : null}
    </View>
  )
}

