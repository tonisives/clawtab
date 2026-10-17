import { createContext, useContext } from "react"
import { Platform, StyleSheet } from "react-native"
import { colors } from "../theme/colors"
import { spacing } from "../theme/spacing"

export let MobileListAppearance = createContext(false)
export let useMobileListAppearance = () => { let mobile = useContext(MobileListAppearance); return Platform.OS !== "web" || mobile }
export let mobileListStyles = StyleSheet.create({
  row: { borderRadius: 0, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight, opacity: 1, paddingVertical: spacing.lg },
})
