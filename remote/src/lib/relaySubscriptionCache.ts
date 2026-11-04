import type { HostedWorkspaceStatus } from "@clawtab/shared"
import { rentalApi, getSubscriptionStatus, type SubscriptionStatus } from "../api/client"

const subscriptions = new Map<string, { value: SubscriptionStatus; loadedAt: number }>()
const requests = new Map<string, Promise<SubscriptionStatus>>()
const freshness = 30_000

export const cachedRelaySubscription = (userId: string | null) => userId ? subscriptions.get(userId)?.value ?? null : null

export function loadRelaySubscription(userId: string, refresh = false): Promise<SubscriptionStatus> {
  const pending = requests.get(userId)
  if (pending) return pending
  const cached = subscriptions.get(userId)
  if (!refresh && cached && Date.now() - cached.loadedAt < freshness) return Promise.resolve(cached.value)
  const request = getSubscriptionStatus(undefined, userId).then(value => {
    subscriptions.set(userId, { value, loadedAt: Date.now() })
    return value
  }).finally(() => { requests.delete(userId) })
  requests.set(userId, request)
  return request
}

const workspaces = new Map<string, { value: HostedWorkspaceStatus; loadedAt: number }>()
const workspaceRequests = new Map<string, Promise<HostedWorkspaceStatus>>()
export const cachedRelayWorkspace = (userId: string | null) => userId ? workspaces.get(userId)?.value ?? null : null

export function loadRelayWorkspace(userId: string): Promise<HostedWorkspaceStatus> {
  const pending = workspaceRequests.get(userId)
  if (pending) return pending
  const cached = workspaces.get(userId)
  if (cached && Date.now() - cached.loadedAt < freshness) return Promise.resolve(cached.value)
  const request = rentalApi<HostedWorkspaceStatus>("GET", "/hosted-workspace").then(value => {
    workspaces.set(userId, { value, loadedAt: Date.now() })
    return value
  }).finally(() => { workspaceRequests.delete(userId) })
  workspaceRequests.set(userId, request)
  return request
}
