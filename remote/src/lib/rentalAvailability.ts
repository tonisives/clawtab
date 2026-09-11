export type RentalCapabilities = { enabled: boolean; ios_storefronts: string[]; android_storefronts: string[] }
export type RentalAvailability = { purchases: boolean; storefront?: string; reason?: "paused" | "region" | "storefront" | "connection" }

export let resolveRentalAvailability = async (
  capabilities: RentalCapabilities,
  platform: string,
  getStorefront: () => Promise<string>,
): Promise<RentalAvailability> => {
  if (!capabilities.enabled) return { purchases: false, reason: "paused" }
  if (platform === "web") return { purchases: true }
  let storefront: string
  try {
    storefront = (await getStorefront()).trim().toUpperCase()
    if (!storefront) return { purchases: false, reason: "storefront" }
  } catch {
    return { purchases: false, reason: "storefront" }
  }
  let allowed = platform === "ios" ? capabilities.ios_storefronts : capabilities.android_storefronts
  return allowed.includes(storefront) ? { purchases: true, storefront } : { purchases: false, storefront, reason: "region" }
}

export let rentalAvailabilityMessage = (reason?: RentalAvailability["reason"]) => {
  if (reason === "paused") return "New rentals are paused. Your existing boxes are still available."
  if (reason === "region") return "Rental checkout isn’t available in your store region."
  if (reason === "storefront") return "Couldn’t check your store region. Try again."
  return "Couldn’t check rental availability. Try again."
}
