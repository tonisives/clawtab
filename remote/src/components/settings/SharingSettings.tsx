import { useEffect, useState, useCallback, useMemo } from "react"
import { View, Text, ActivityIndicator } from "react-native"
import { ShareSection } from "@clawtab/shared"
import { useJobsStore } from "../../store/jobs"
import * as api from "../../api/client"
import { confirm, alertError } from "../../lib/platform"
import { colors } from "../../theme/colors"
import { SettingsPage, styles } from "./SettingsPage"
export let SharingSettings = () => {
  let [shares, setShares] = useState<api.SharesResponse>({ shared_by_me: [], shared_with_me: [] })
  let [sharesLoading, setSharesLoading] = useState(true)
  let jobs = useJobsStore((s) => s.jobs)
  let availableGroups = useMemo(() => {
    let groups = new Set(jobs.map((j) => j.group || "default"))
    return [...groups].sort()
  }, [jobs])
  let fetchShares = useCallback(async () => {
    try {
      let s = await api.getShares()
      setShares(s)
    } catch (e) {
      console.error("Failed to fetch shares:", e)
    }
  }, [])
  let handleAddShare = useCallback(
    async (email: string) => {
      await api.addShare(email)
      await fetchShares()
    },
    [fetchShares],
  )
  let handleToggleGroup = useCallback(
    async (shareId: string, group: string) => {
      let share = shares.shared_by_me.find((s) => s.id === shareId)
      if (!share) return
      let newGroups: string[] | null
      if (share.allowed_groups === null) {
        newGroups = availableGroups.filter((g) => g !== group)
      } else if (share.allowed_groups.includes(group)) {
        newGroups = share.allowed_groups.filter((g) => g !== group)
        if (newGroups.length === 0) newGroups = null
      } else {
        newGroups = [...share.allowed_groups, group]
        if (availableGroups.every((g) => newGroups!.includes(g))) {
          newGroups = null
        }
      }
      setShares((prev) => ({
        ...prev,
        shared_by_me: prev.shared_by_me.map((s) =>
          s.id === shareId ? { ...s, allowed_groups: newGroups } : s,
        ),
      }))
      try {
        await api.updateShare(shareId, newGroups)
      } catch (e) {
        alertError("Error", e instanceof Error ? e.message : String(e))
        await fetchShares()
      }
    },
    [shares, availableGroups, fetchShares],
  )
  let handleRemoveShare = useCallback(
    (shareId: string, email: string) => {
      confirm("Remove access", `Remove shared access for ${email}?`, async () => {
        try {
          await api.removeShare(shareId)
          await fetchShares()
        } catch (e) {
          alertError("Error", e instanceof Error ? e.message : String(e))
        }
      })
    },
    [fetchShares],
  )
  useEffect(() => { void fetchShares().finally(() => setSharesLoading(false)) }, [fetchShares])
  return <SettingsPage>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Shared access</Text>
      {sharesLoading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <ShareSection
        sharedByMe={shares.shared_by_me}
        sharedWithMe={shares.shared_with_me}
        availableGroups={availableGroups}
        loading={sharesLoading}
        onAdd={handleAddShare}
        onToggleGroup={handleToggleGroup}
        onRemove={handleRemoveShare}
        onLeave={handleRemoveShare}
      />}
    </View>
  </SettingsPage>
}
