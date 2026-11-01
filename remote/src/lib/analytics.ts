// Native apps do not collect web onboarding analytics.
export let initializeWebAnalytics = () => {}
export let trackRemoteEvent = (_event: "login" | "remote_pairing_complete") => {}
export let trackConnectedHost = () => {}

export let trackFunnelEvent = (_event: import("../../../shared/src/funnel").FunnelEvent) => {}
