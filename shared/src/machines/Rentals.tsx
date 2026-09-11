import { useEffect, useRef, useState } from "react"
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native"
import { machineRequest, machineSend, machineState, resourceKey, newOperationId, selectMachine, useMachines } from "./client"
import { colors } from "../theme/colors"
import { MachineTerminalScreen } from "./Terminal"

type Quote = {
  server_type: string
  region: string
  region_description: string
  memory_gb: number
  cores: number
  disk_gb: number
  traffic_bytes: number
  monthly_cents: number
  cost_cents: number
  currency: string
}
type Rental = {
  id: string
  name: string
  state: string
  quote: Quote
  machine_id: string | null
  paid_until: string | null
  delete_at: string | null
  past_due: boolean
  cancel_requested: boolean
  checkout_url?: string | null
  agent_provider: string
  setup: Record<string, any>
  apple_relay_subscription: boolean
  billing_transition_pending: boolean
  traffic_paused: boolean
  needs_attention: boolean
}
type RentalApi = (method: string, path: string, body?: Record<string, unknown>) => Promise<any>
type Props = { showExistingRentals?: boolean; allowNewRentals?: boolean; onOrderingChange?: (ordering: boolean) => void; api: RentalApi; purchases: boolean; platform?: "web" | "desktop" | "ios" | "android"; storefront?: string; openUrl?: (url: string) => Promise<unknown> }
type Terminal = { machine: string; pane: string; session: string; command: string }
let money = (quote: Quote) => new Intl.NumberFormat(undefined, { style: "currency", currency: quote.currency }).format(quote.monthly_cents / 100)
let date = (value: string) => new Date(value).toLocaleString()
let quoteId = (quote: Quote) => `${quote.region}/${quote.server_type}`
export let recommendRegion = (timezone: string, regions: string[]) => {
  let preferred = timezone.startsWith("America/")
    ? (/Los_Angeles|Vancouver|Phoenix|Denver|Anchorage/.test(timezone) ? ["hil", "ash"] : ["ash", "hil"])
    : /^(Asia|Australia|Pacific)\//.test(timezone) ? ["sin", "hel1"] : ["fsn1", "nbg1", "hel1"]
  return preferred.find((region) => regions.includes(region)) ?? regions[0]
}
let Button = ({ label, onPress, disabled = false, primary = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) => (
  <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={[styles.button, primary && styles.primaryButton, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
  </Pressable>
)

export let RentalsPanel = ({ api, purchases, platform = "web", storefront, openUrl, onOrderingChange, allowNewRentals = true, showExistingRentals = true }: Props) => {
  let machines = useMachines()
  let [rentals, setRentals] = useState<Rental[]>([])
  let [purchasedRental, setPurchasedRental] = useState<string | null>(null)
  let visibleRentals = showExistingRentals ? rentals : rentals.filter((rental) => rental.id === purchasedRental)
  let [catalog, setCatalog] = useState<Quote[]>([])
  let [enabled, setEnabled] = useState(false)
  let [managed, setManaged] = useState<string | null>(null)
  let [customize, setCustomize] = useState(false)
  let [showTerms, setShowTerms] = useState(false)
  let [showOrder, setShowOrder] = useState(false)
  useEffect(() => { onOrderingChange?.(showOrder) }, [showOrder, onOrderingChange])
  let [selected, setSelected] = useState("")
  let [name, setName] = useState("My coding box")
  let [provider, setProvider] = useState(() => {
    let preferred = machines.agentModels?.default_provider
    return preferred && ["codex", "claude", "opencode"].includes(preferred) ? preferred : "codex"
  })
  let pending = useRef(false)
  let [keys, setKeys] = useState("")
  let [accepted, setAccepted] = useState(false)
  let [busy, setBusy] = useState(false)
  let [error, setError] = useState<string | null>(null)
  let [confirmation, setConfirmation] = useState<{ id: string; action: "cancel" | "delete" } | null>(null)
  let [confirmName, setConfirmName] = useState("")
  let [terminal, setTerminal] = useState<Terminal | null>(null)
  let requestId = useRef<string | null>(null)
  let quote = catalog.find((candidate) => quoteId(candidate) === selected)
  let refresh = async () => {
    let result = await api("GET", "/rentals")
    setRentals(result.rentals)
  }
  useEffect(() => {
    let active = true
    let load = async () => {
      try {
        let result = await api("GET", "/rentals")
        if (active) setRentals(result.rentals)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Could not load rented boxes")
      }
    }
    void load()
    let timer = setInterval(load, 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [api])
  let act = (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    void work().catch((error) => setError(error instanceof Error ? error.message : "Box operation failed")).finally(() => { pending.current = false; setBusy(false) })
  }
  let startOrder = () => act(async () => {
    let result = await api("GET", "/rentals/catalog")
    setEnabled(result.enabled)
    let quotes: Quote[] = result.quotes
    setCatalog(quotes)
    let region = recommendRegion(Intl.DateTimeFormat().resolvedOptions().timeZone, quotes.map((quote) => quote.region))
    let suggested = quotes.find((quote) => quote.region === region && quote.memory_gb === 4) ?? quotes[0]
    setSelected(suggested ? quoteId(suggested) : "")
    setShowOrder(true)
    setCustomize(false)
    setShowTerms(false)
    setAccepted(false)
    requestId.current = null
  })
  let purchase = () => act(async () => {
    if (!quote || !accepted || !openUrl) return
    requestId.current ??= newOperationId()
    let response = await api("POST", "/rentals/checkout", {
      request_id: requestId.current, name, quote, agent_provider: provider, platform, storefront, ssh_keys: keys.split("\n").map((key) => key.trim()).filter(Boolean), accepted_terms: accepted,
    })
    setPurchasedRental(response.rental_id)
    await refresh()
    await openUrl(response.url)
    setShowOrder(false)
  })
  let openTerminal = (rental: Rental, command = "") => () => act(async () => {
    if (!rental.machine_id) return
    selectMachine(rental.machine_id)
    let result = await machineRequest(rental.machine_id, { type: "run_agent", provider: "shell", prompt: command, work_dir: "/home/clawtab/workspace", operation_id: newOperationId() }, 120_000)
    if (!result.success || !result.pane_id || !result.tmux_session) throw new Error(result.error ?? "Could not open a terminal")
    setTerminal({ machine: rental.machine_id, pane: result.pane_id, session: result.tmux_session, command })
  })
  let setupAgent = (rental: Rental, action: "login" | "agent", restart = false) => () => act(async () => {
    if (!rental.machine_id) return
    let provider = rental.agent_provider
    let setup = await api("POST", `/rentals/${rental.id}/setup`, { action: restart ? `restart_${action}` : "prepare", provider })
    let command = action === "login" ? ({ codex: "codex login --device-auth", claude: "claude auth login", opencode: "opencode auth login" }[provider] ?? "") : ""
    if (restart) await refresh()
    let saved = setup[`${action}_terminal`]
    let result = saved ?? await machineRequest(rental.machine_id, {
      type: "run_agent", provider: action === "login" ? "shell" : provider,
      prompt: command, work_dir: "/home/clawtab/workspace", operation_id: setup[`${action}_operation_id`],
    }, 120_000)
    if ((!saved && !result.success) || !result.pane_id || !result.tmux_session) throw new Error(result.error ?? "Could not start setup terminal")
    if (!saved) await api("POST", `/rentals/${rental.id}/setup`, { action, provider, terminal: { pane_id: result.pane_id, tmux_session: result.tmux_session } })
    selectMachine(rental.machine_id)
    if (!machineState().controllers[resourceKey(rental.machine_id, result.pane_id)]) {
      machineSend(rental.machine_id, { type: "take_control", pane_id: result.pane_id })
    }
    setTerminal({ machine: rental.machine_id, pane: result.pane_id, session: result.tmux_session, command })
    await refresh()
  })
  let resumeCheckout = (rental: Rental) => () => act(async () => {
    if (rental.checkout_url && openUrl) await openUrl(rental.checkout_url)
  })
  let pay = (rental: Rental) => () => act(async () => {
    let response = await api("POST", `/rentals/${rental.id}/payment`)
    await openUrl?.(response.url)
  })
  let ask = (rental: Rental, action: "cancel" | "delete") => () => {
    setConfirmation({ id: rental.id, action })
    setConfirmName("")
  }
  let confirm = () => act(async () => {
    if (!confirmation) return
    await api("POST", `/rentals/${confirmation.id}/${confirmation.action}`, confirmation.action === "delete" ? { confirm_name: confirmName } : {})
    setConfirmation(null)
    await refresh()
  })
  let dismiss = () => setConfirmation(null)
  let closeTerminal = () => setTerminal(null)
  let toggleCustomize = () => setCustomize(!customize)
  let toggleTerms = () => setShowTerms(!showTerms)
  let toggleAccepted = () => setAccepted(!accepted)
  let closeOrder = () => setShowOrder(false)
  let choose = (quote: Quote) => () => { setSelected(quoteId(quote)); setAccepted(false); requestId.current = null }
  let editName = (value: string) => { setName(value); requestId.current = null }
  let editKeys = (value: string) => { setKeys(value); requestId.current = null }
  if ((!purchases || !allowNewRentals) && visibleRentals.length === 0 && !error) return null
  return (
    <View style={styles.panel}>
      {!showOrder && <View style={styles.row}>
        <Text style={styles.heading}>{visibleRentals.length ? "Your boxes" : "Rent a machine"}</Text>
        {allowNewRentals && purchases && visibleRentals.length > 0 && !showOrder && <Button label="Rent a box" onPress={startOrder} disabled={busy} />}
      </View>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {allowNewRentals && purchases && !visibleRentals.length && !showOrder && <>
        <Text style={styles.detail}>Ready for your agents. Relay included.</Text>
        <Button label={busy ? "Loading boxes…" : "Rent a box"} onPress={startOrder} disabled={busy} primary />
      </>}
      {showOrder && <View style={styles.card}>
        {!enabled ? <Text style={styles.text}>New rentals are currently unavailable.</Text> : <>
          <Text style={styles.heading}>Choose your box</Text>
          <View style={styles.row}>{(customize ? catalog : quote ? [quote] : []).map((candidate) => <Pressable key={quoteId(candidate)} accessibilityRole="button" accessibilityState={{ selected: selected === quoteId(candidate) }} onPress={choose(candidate)} style={[styles.choice, selected === quoteId(candidate) && styles.selected]}>
            <Text style={styles.text}>{candidate.memory_gb} GB · {candidate.region_description}</Text>
            <Text style={styles.detail}>{candidate.cores} vCPU · {candidate.disk_gb} GB disk · {(candidate.traffic_bytes / 1e12).toFixed(1)} TB outgoing traffic</Text>
            <Text style={styles.text}>{money(candidate)} / month, plus applicable tax</Text>
          </Pressable>)}</View>
          {!catalog.length && <Text style={styles.text}>No eligible boxes are available right now.</Text>}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: customize }} onPress={toggleCustomize} style={styles.disclosure}><Text style={styles.link}>{customize ? "Done customizing" : "Customize box"}</Text></Pressable>
          {customize && <>
            <Text style={styles.text}>Box name</Text>
            <TextInput accessibilityLabel="Box name" value={name} onChangeText={editName} maxLength={80} style={styles.input} />
          </>}
          <Text style={styles.text}>First agent</Text>
          <View style={styles.row}>{["codex", "claude", "opencode"].map((choice) => <Pressable key={choice} accessibilityRole="radio" accessibilityState={{ selected: provider === choice }} onPress={() => { setProvider(choice); requestId.current = null }} style={[styles.button, styles.providerChoice, provider === choice && styles.selected]}><Text style={styles.buttonText}>{choice === "claude" ? "Claude" : choice === "codex" ? "Codex" : "OpenCode"}</Text></Pressable>)}</View>
          {customize && <>
            <Text style={styles.text}>SSH public keys (optional, one per line)</Text>
            <TextInput accessibilityLabel="SSH public keys" value={keys} onChangeText={editKeys} multiline autoCapitalize="none" style={styles.input} />
          </>}
          <Text style={styles.detail}>Relay included. Bring your own AI account.</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTerms }} onPress={toggleTerms} style={styles.disclosure}><Text style={styles.link}>{showTerms ? "Hide rental terms" : "Rental and deletion terms"}</Text></Pressable>
          {showTerms && <>
          <Text style={styles.detail}>Includes ClawTab, tmux, Git, Claude Code, Codex, and OpenCode. Authorize your own AI accounts in the terminal. Relay access for this box and your own machines is included. AI usage is billed by your AI provider.</Text>
          <Text style={styles.detail}>Once your box is ready, an existing Stripe relay plan is canceled and its unused paid time credited to future invoices (refunded if the currency differs). Apple plans must be canceled in Apple subscription settings.</Text>
          <Text style={styles.detail}>Billed monthly in advance at provider cost plus 20%. No automatic backups. Cancellation ends renewal; the box is deleted at period end. A failed renewal has 10 days to recover before permanent deletion. Networking pauses at 90% of included traffic until the next provider month. Immediate deletion has no automatic prorated refund.</Text>
          </>}
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: accepted }} onPress={toggleAccepted} style={styles.acceptance}>
            <View style={[styles.checkbox, accepted && styles.checked]}>{accepted && <View style={styles.checkmark} />}</View>
            <Text style={styles.acceptanceText}>I accept the rental and deletion terms.</Text>
          </Pressable>
          <Button primary label={busy ? "Opening checkout…" : "Continue to checkout"} disabled={busy || !quote || !accepted || !name.trim()} onPress={purchase} />
        </>}
        <Button label="Close" onPress={closeOrder} />
      </View>}
      {visibleRentals.map((rental) => {
        let available = rental.machine_id && machines.machines.some((machine) => machine.id === rental.machine_id && machine.online)
        let managing = managed === rental.id
        let providerName = rental.agent_provider === "claude" ? "Claude Code" : rental.agent_provider === "codex" ? "Codex" : "OpenCode"
        let finished = ["deleted", "failed"].includes(rental.state)
        return <View key={rental.id} style={styles.card}>
          <Text style={styles.heading}>{rental.name}</Text>
          <Text style={styles.text}>{rental.state === "checkout" ? "Waiting for payment" : rental.state === "provisioning" ? "Installing and connecting your box…" : rental.state === "deleting" ? "Deleting server and data…" : rental.state === "ready" ? (available ? "Ready" : "Offline") : rental.state === "failed" ? "Order closed" : "Permanently deleted"}</Text>
          {purchases && <Text style={styles.detail}>{rental.quote.memory_gb} GB · {rental.quote.region_description} · {money(rental.quote)} / month, plus applicable tax</Text>}
          {rental.traffic_paused && <Text style={styles.error}>Networking is paused until the next provider month because this box reached its traffic allowance.</Text>}
          {rental.past_due && !finished && <Text style={styles.error}>Renewal payment is overdue. Pay before the deletion deadline to keep your box.</Text>}
          {rental.delete_at && !finished && <Text style={styles.error}>Permanent deletion: {date(rental.delete_at)}. Download important files before then.</Text>}
          {rental.state === "ready" && <Text style={styles.detail}>Sign in to your AI account, then start an agent.</Text>}
          {rental.billing_transition_pending && <Text style={styles.detail}>Switching your existing relay billing. Any unused paid time will be credited automatically.</Text>}
          {rental.apple_relay_subscription && !finished && <Text style={styles.detail}>Your Apple relay subscription is still active. Cancel it in Apple subscription settings to avoid paying for relay twice; Apple billing cannot be changed here.</Text>}
          {rental.needs_attention && !finished && <Text style={styles.detail}>An operation is being retried. Your box status will update automatically.</Text>}
          <View style={styles.row}>
            {rental.state === "ready" && <Button primary={!rental.setup.login_terminal} label={rental.setup.login_terminal ? "Resume sign-in" : `Sign in to ${providerName}`} onPress={setupAgent(rental, "login")} disabled={busy || !available} />}
            {rental.state === "ready" && <Button primary={!!rental.setup.login_terminal} label={rental.setup.agent_terminal ? "Open agent" : "Start agent"} onPress={setupAgent(rental, "agent")} disabled={busy || !available} />}
            {managing && rental.state === "ready" && rental.setup.login_terminal && <Button label="New sign-in terminal" onPress={setupAgent(rental, "login", true)} disabled={busy || !available} />}
            {managing && rental.state === "ready" && rental.setup.agent_terminal && <Button label="Start another agent" onPress={setupAgent(rental, "agent", true)} disabled={busy || !available} />}
            {!finished && <Button label={managing ? "Done managing" : "Manage box"} onPress={() => { setManaged(managing ? null : rental.id); setConfirmation(null) }} />}
            {managing && rental.state === "ready" && <Button label="Open terminal" onPress={openTerminal(rental)} disabled={busy || !available} />}
            {purchases && rental.state === "checkout" && rental.checkout_url && <Button label="Resume checkout" onPress={resumeCheckout(rental)} disabled={busy} />}
            {managing && rental.apple_relay_subscription && openUrl && <Button label="Manage Apple subscription" onPress={() => act(async () => { await openUrl("https://apps.apple.com/account/subscriptions") })} disabled={busy} />}
            {managing && purchases && !finished && <Button label="Manage payment" onPress={pay(rental)} disabled={busy} />}
            {managing && purchases && !finished && !rental.cancel_requested && <Button label="Cancel renewal" onPress={ask(rental, "cancel")} disabled={busy} />}
            {managing && purchases && !finished && <Button label="Delete now" onPress={ask(rental, "delete")} disabled={busy} />}
          </View>
          {confirmation?.id === rental.id && <View style={styles.card}>
            <Text style={styles.text}>{confirmation.action === "delete" ? "This permanently deletes your server and files now. There is no automatic prorated refund. Type the box name to confirm." : "Stop renewal and permanently delete this box and its files at the end of its paid period?"}</Text>
            {confirmation.action === "delete" && <TextInput accessibilityLabel="Confirm box name" value={confirmName} onChangeText={setConfirmName} style={styles.input} />}
            <View style={styles.row}><Button label="Confirm" onPress={confirm} disabled={busy || (confirmation.action === "delete" && confirmName !== rental.name)} /><Button label="Keep box" onPress={dismiss} /></View>
          </View>}
        </View>
      })}
      {terminal && <MachineTerminalScreen machineId={terminal.machine} paneId={terminal.pane} tmuxSession={terminal.session}
        title={terminal.command ? "Provider sign-in" : "Terminal"} signIn={!!terminal.command} onClose={closeTerminal} />}
    </View>
  )
}
let styles = StyleSheet.create({
  panel: { gap: 12, padding: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14 },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 13 },
  card: { gap: 10, padding: 14, backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border },
  choice: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight },
  disclosure: { minHeight: 40, justifyContent: "center", alignSelf: "flex-start" },
  link: { color: colors.accent, fontSize: 13 },
  providerChoice: { flex: 1, paddingHorizontal: 10 },
  acceptance: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  acceptanceText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 },
  checkbox: { width: 20, height: 20, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: colors.accentBg, borderColor: colors.accent },
  checkmark: { width: 10, height: 6, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.accent, transform: [{ rotate: "-45deg" }] },
  selected: { borderColor: colors.accent, backgroundColor: colors.accentBg },
  button: { minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  primaryButton: { backgroundColor: colors.accentBg, borderColor: colors.accent },
  primaryText: { color: colors.accent },
  disabled: { opacity: 0.5 },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 12, padding: 10, fontSize: 14 },
})
