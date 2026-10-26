import { createContext, useContext } from "react"
export type SettingsRoute = "home" | "account" | "usage" | "machines" | "sharing" | "terminal" | "tokens"
export let SettingsNavigation = createContext<(page: SettingsRoute) => void>(() => {})
export let useSettingsNavigation = () => useContext(SettingsNavigation)

export let SettingsVisibility = createContext(true)
export let useSettingsVisible = () => useContext(SettingsVisibility)
