export let createAnswerTracker = (record: () => void, now = Date.now) => {
  let pending = new Map<string, number>()
  return {
    sent(id: string) {
      for (let [key, at] of pending) if (now() - at > 60_000) pending.delete(key)
      if (pending.size >= 100) pending.delete(pending.keys().next().value!)
      pending.set(id, now())
    },
    acknowledged(id: string, success: boolean) {
      let at = pending.get(id)
      pending.delete(id)
      if (at !== undefined && success && now() - at <= 60_000) record()
    },
  }
}
