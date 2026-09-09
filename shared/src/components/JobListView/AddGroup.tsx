import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { machineHostRequest, newOperationId, saveAccountPreferences, useMachines } from "../../machines/client";
import { MachineTargetPicker } from "../../machines/TargetPicker";
import { colors } from "../../theme/colors";
import { spacing } from "../../theme/spacing";
import { matchesSavedGroup, normalizeGroupPath, savedGroupKey } from "../../util/jobGroups";
import type { JobListViewHook } from "./useJobListView";

export let AddGroup = ({ hook }: { hook: JobListViewHook }) => {
  let machines = useMachines();
  let [open, setOpen] = useState(false);
  let [name, setName] = useState("");
  let [path, setPath] = useState("~");
  let [target, setTarget] = useState<string | null>(null);
  let [error, setError] = useState<string | null>(null);
  let [busy, setBusy] = useState(false);
  let pending = useRef(false);
  let operationId = useRef("");
  let show = () => {
    let selected = machines.machines.find((machine) => machine.id === machines.selected && machine.online && machine.owned);
    setTarget(selected?.id ?? hook.localAgentMachineId ?? machines.machines.find((machine) => machine.online && machine.owned)?.id ?? null);
    operationId.current = newOperationId();
    setError(null);
    setOpen(true);
  };
  let cancel = () => { if (!pending.current) setOpen(false); };
  let create = async () => {
    if (pending.current || !hook.groupPreferencesApi) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!name.trim()) throw new Error("Enter a group name.");
      if (!target) throw new Error("Choose an online machine.");
      let local = target === hook.localAgentMachineId && hook.localHostRequest;
      let machine = machines.machines.find((machine) => machine.id === target);
      if (!local && (!machine?.online || !machine.owned)) throw new Error("Choose an online machine.");
      let request = { action: "list_directory", path: path.trim() || "~" };
      let folder = local ? await local(request) : await machineHostRequest(target, request);
      if (typeof folder.path !== "string" || !folder.path.startsWith("/")) throw new Error("Could not resolve the folder on this machine.");
      let workDir = normalizeGroupPath(folder.path);
      let duplicate = Object.values(machines.jobGroups).some((group) => group.id !== operationId.current && matchesSavedGroup(group, workDir, target));
      if (duplicate) throw new Error("A group already uses this folder on this machine.");
      let group = { id: operationId.current, name: name.trim(), machine_id: target, work_dir: workDir };
      await saveAccountPreferences(hook.groupPreferencesApi, { job_group: group });
      hook.setSearchQuery("");
      hook.onListModeChange?.("tabs");
      if (hook.collapsedGroups.has(savedGroupKey(group))) hook.onToggleGroup(savedGroupKey(group));
      setOpen(false);
      setName("");
      setPath("~");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create group.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!hook.groupPreferencesApi) return null;
  if (!open) return (
    <Pressable accessibilityRole="button" onPress={show} style={styles.add}>
      <Text style={styles.action}>Add new group</Text>
    </Pressable>
  );
  return (
    <View style={styles.form}>
      <Text style={styles.title}>Add new group</Text>
      <TextInput accessibilityLabel="Group name" placeholder="Group name" placeholderTextColor={colors.textSecondary} value={name} onChangeText={setName} editable={!busy} maxLength={100} autoFocus style={styles.input} />
      <TextInput accessibilityLabel="Group folder" placeholder="Folder on selected machine" placeholderTextColor={colors.textSecondary} value={path} onChangeText={setPath} editable={!busy} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <Text style={styles.hint}>Use an existing folder. ~ opens the selected machine’s home folder.</Text>
      <View pointerEvents={busy ? "none" : "auto"}>
        <MachineTargetPicker target={target} localMachineId={hook.localAgentMachineId} onSelect={setTarget} />
      </View>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={cancel} style={styles.button}><Text style={styles.hint}>Cancel</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={create} style={styles.button}><Text style={styles.action}>{busy ? "Creating…" : "Create group"}</Text></Pressable>
      </View>
    </View>
  );
};

let styles = StyleSheet.create({
  add: { padding: spacing.md, marginTop: spacing.md, alignItems: "center" },
  action: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  form: { marginTop: spacing.md, padding: spacing.md, gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  title: { color: colors.text, fontSize: 14, fontWeight: "600" },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: spacing.sm, fontSize: 14 },
  hint: { color: colors.textSecondary, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  button: { padding: spacing.sm },
});
