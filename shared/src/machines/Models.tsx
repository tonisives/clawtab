import { useRef, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { colors } from "../theme/colors"
import { spacing } from "../theme/spacing"
import { CURRENT_AGENT_MODEL_OPTIONS, isSyntheticAgentModel, type ProcessProvider } from "../types/process"
import { labelForProvider, modelPickerLabel } from "../util/agent"
import { geminiBaseModel, groupAgentModelOptions, hostModelCatalog, resolveEnabledModels } from "../util/agentModels"
import {
  machineErrorMessage,
  machineRequest,
  saveAccountPreferences,
  saveAgentModelPreferences,
  useMachines,
  type AgentModelPreferences,
  type PreferencesApi,
} from "./client"

const PROVIDERS: ProcessProvider[] = ["codex", "claude", "opencode", "antigravity"]

type ModelRowProps = {
  id: string
  name: string
  enabled: boolean
  isDefault: boolean
  busy: boolean
  compact: boolean
  onToggle: (id: string, enabled: boolean) => void
  onDefault: (id: string) => void
}

let ModelRow = ({ id, name, enabled, isDefault, busy, compact, onToggle, onDefault }: ModelRowProps) => {
  let toggle = () => onToggle(id, !enabled)
  let setDefault = () => onDefault(id)
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelName}>
        <Text style={styles.text}>{compact ? modelPickerLabel(geminiBaseModel(id), name) : name}</Text>
        {!compact && name !== id && <Text style={styles.hint}>{id}</Text>}
      </View>
      {enabled && !compact && <Pressable accessibilityRole="button" accessibilityLabel={`Use ${id} by default`} disabled={busy} onPress={setDefault} style={styles.smallButton}>
        <Text style={isDefault ? styles.selectedText : styles.hint}>{isDefault ? "Default" : "Set default"}</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={`${enabled ? "Remove" : "Add"} ${id}`} accessibilityState={{ disabled: busy }} disabled={busy} onPress={toggle} style={[styles.smallButton, enabled && styles.enabledButton]}>
        <Text style={enabled ? styles.selectedText : styles.text}>{enabled ? "Remove" : "Add"}</Text>
      </Pressable>
    </View>
  )
}

export let ModelManager = ({ machineId, api, compact = false }: { machineId?: string; api?: PreferencesApi; compact?: boolean }) => {
  let state = useMachines()
  let target = machineId ?? state.selected ?? state.machines.find((machine) => machine.owned && machine.online)?.id
  let machine = state.machines.find((item) => item.id === target && item.owned)
  let settings = machine ? state.snapshots[machine.id]?.settings_response : undefined
  let preferences: AgentModelPreferences = state.agentModels ?? {
    enabled_models: settings?.enabled_models ?? {},
    disabled_models: settings?.disabled_models ?? {},
    default_provider: settings?.default_provider ?? "codex",
    default_model: settings?.default_model ?? null,
  }
  let detected = hostModelCatalog(settings)
  let enabledModels = resolveEnabledModels(preferences.enabled_models, detected, preferences.disabled_models)
  let [provider, setProvider] = useState<ProcessProvider>("codex")
  let [customModel, setCustomModel] = useState("")
  let [search, setSearch] = useState("")
  let [busy, setBusy] = useState(false)
  let [error, setError] = useState<string | null>(null)
  let saving = useRef(false)
  let enabledIds = new Set(enabledModels[provider] ?? CURRENT_AGENT_MODEL_OPTIONS.filter((option) => option.provider === provider).flatMap((option) => option.modelId ? [option.modelId] : []))
  let known = new Map<string, string>(detected[provider] ?? CURRENT_AGENT_MODEL_OPTIONS.filter((option) => option.provider === provider).flatMap((option) => option.modelId ? [[option.modelId, option.label] as [string, string]] : []))
  for (let id of [...enabledIds, ...(preferences.disabled_models?.[provider] ?? [])]) {
    if (!known.has(id)) known.set(id, id)
  }
  let query = search.trim().toLowerCase()
  let models = groupAgentModelOptions([...known].filter(([id]) => !isSyntheticAgentModel(id)).map(([modelId, label]) => ({ provider, modelId, label })))
    .filter((option) => !query || `${option.modelId} ${option.label}`.toLowerCase().includes(query))
  let modelIds = (id: string) => {
    let option = models.find((model) => model.modelId === id)
    return [id, ...Object.values(option?.effortModels ?? {}), ...(option?.effortModels ? [geminiBaseModel(id)] : [])]
  }
  let action = async (work: () => Promise<unknown>) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (error) {
      setError(machineErrorMessage(error, "Could not save models"))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  let save = (next: AgentModelPreferences) => api
    ? saveAccountPreferences(api, { agent_models: next })
    : saveAgentModelPreferences(next)
  let toggleModel = (id: string, enabled: boolean) => void action(async () => {
    let selected = new Set(enabledIds)
    let excluded = new Set(preferences.disabled_models?.[provider] ?? [])
    for (let value of modelIds(id)) {
      if (enabled) {
        if (known.has(value) && (value !== geminiBaseModel(id) || value === id)) selected.add(value)
        excluded.delete(value)
      } else {
        selected.delete(value)
        excluded.add(value)
      }
    }
    await save({
      ...preferences,
      enabled_models: { ...preferences.enabled_models, [provider]: [...selected] },
      disabled_models: { ...preferences.disabled_models, [provider]: [...excluded] },
      default_model: !enabled && preferences.default_provider === provider && modelIds(id).includes(preferences.default_model ?? "") ? null : preferences.default_model,
    })
  })
  let addCustomModel = () => void action(async () => {
    let id = customModel.trim()
    if (!id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || isSyntheticAgentModel(id)) throw new Error("Enter a valid model identifier")
    await save({
      ...preferences,
      enabled_models: { ...preferences.enabled_models, [provider]: [...new Set([...enabledIds, id])] },
      disabled_models: { ...preferences.disabled_models, [provider]: (preferences.disabled_models?.[provider] ?? []).filter((value) => value !== id && value !== geminiBaseModel(id)) },
    })
    setCustomModel("")
  })
  let setDefault = (id: string) => void action(() => save({ ...preferences, default_provider: provider, default_model: id }))
  let clearDefault = () => void action(() => save({ ...preferences, default_model: null }))
  let refresh = () => void action(async () => {
    if (!machine?.online) throw new Error("Connect an owned machine to detect models")
    await machineRequest(machine.id, { type: "get_settings", refresh_models: true })
  })
  let chooseProvider = (next: ProcessProvider) => () => {
    setProvider(next)
    setSearch("")
    setCustomModel("")
    setError(null)
  }
  let detectionError = settings?.model_detection_errors?.[provider]
  return (
    <View style={[styles.content, compact && styles.compactContent]}>
      {!compact && <Text style={styles.hint}>Models detected on your machine appear automatically. Add or remove models to customize your agent menus across your machines and apps.</Text>}
      <Pressable accessibilityRole="button" disabled={busy || !machine?.online} onPress={refresh} style={styles.button}>
        <Text style={styles.text}>{busy ? "Updating models..." : compact ? "Refresh models" : "Refresh detected models"}</Text>
      </Pressable>
      {!machine?.online && <Text style={styles.hint}>Connect an owned machine to detect its available models. You can still manage saved models.</Text>}
      <View style={styles.providers}>
        {PROVIDERS.map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: provider === value }} disabled={busy} onPress={chooseProvider(value)} style={[styles.button, provider === value && styles.enabledButton]}>
          <Text style={provider === value ? styles.selectedText : styles.text}>{labelForProvider(value)}</Text>
        </Pressable>)}
      </View>
      {detectionError && <Text style={styles.hint}>{labelForProvider(provider)} detection: {detectionError}. Saved models remain available.</Text>}
      <TextInput accessibilityLabel="Search models" value={search} onChangeText={setSearch} placeholder="Search models" placeholderTextColor={colors.textSecondary} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      {models.slice(0, 100).map((option) => <ModelRow key={option.modelId} id={option.modelId!} name={option.label} enabled={modelIds(option.modelId!).some((id) => enabledIds.has(id))} busy={busy} compact={compact} isDefault={preferences.default_provider === provider && modelIds(option.modelId!).includes(preferences.default_model ?? "")} onToggle={toggleModel} onDefault={setDefault} />)}
      {models.length > 100 && <Text style={styles.hint}>Showing 100 of {models.length} models. Search to find a model.</Text>}
      {models.length === 0 && <Text style={styles.hint}>{query ? "No matching models." : "No models detected. Add a model below or refresh."}</Text>}
      <View style={styles.addRow}>
        <TextInput accessibilityLabel="Custom model identifier" value={customModel} onChangeText={setCustomModel} onSubmitEditing={addCustomModel} editable={!busy} placeholder="Custom model identifier" placeholderTextColor={colors.textSecondary} autoCapitalize="none" autoCorrect={false} style={[styles.input, styles.customInput]} />
        <Pressable accessibilityRole="button" accessibilityLabel="Add custom model" disabled={busy || !customModel.trim()} onPress={addCustomModel} style={styles.button}><Text style={styles.text}>Add</Text></Pressable>
      </View>
      {!compact && preferences.default_model && <Pressable accessibilityRole="button" disabled={busy} onPress={clearDefault} style={styles.button}><Text style={styles.hint}>Clear default model</Text></Pressable>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  compactContent: { padding: spacing.md },
  providers: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  button: { padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 8, alignItems: "center" },
  smallButton: { padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  enabledButton: { backgroundColor: colors.accentBg, borderColor: colors.accentDim },
  text: { color: colors.text, fontSize: 13 },
  hint: { color: colors.textSecondary, fontSize: 12 },
  selectedText: { color: colors.accent, fontSize: 13 },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border },
  modelName: { flex: 1, gap: 2 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: spacing.sm, color: colors.text, fontSize: 13 },
  customInput: { flex: 1 },
  addRow: { flexDirection: "row", gap: spacing.sm },
  error: { color: colors.danger, fontSize: 13 },
})
