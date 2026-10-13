import { useEffect, useState, type ReactNode } from "react"
import { useNavigation, useRoute } from "expo-router/react-navigation"
import { MachineNavigationProvider, useMachineNavigation, type MachineOnboardingContent } from "../../../shared/src/machines/Onboarding"
import { SettingsPage } from "./settings/SettingsPage"

type MachinePage = { title: string; content: MachineOnboardingContent }
export type MachinePageParams = { id: string; title: string }
type Navigation = { push: (name: "machine-page", params: MachinePageParams) => void; goBack: () => void }
let pages = new Map<string, MachinePage>()
let nextPage = 0

export let MachineNavigation = ({ children }: { children: ReactNode }) => {
  let navigation = useNavigation<Navigation>()
  let parent = useMachineNavigation()
  let push = (page: MachinePage) => {
    let id = String(++nextPage)
    pages.set(id, page)
    navigation.push("machine-page", { id, title: page.title })
  }
  return <MachineNavigationProvider value={parent ?? { push }}>{children}</MachineNavigationProvider>
}

export let MachinePageScreen = () => {
  let navigation = useNavigation<Navigation>()
  let route = useRoute() as { params: MachinePageParams }
  let [page] = useState(() => pages.get(route.params.id))
  useEffect(() => () => { pages.delete(route.params.id) }, [route.params.id])
  let close = () => navigation.goBack()
  let body = typeof page?.content === "function" ? page.content(close) : page?.content
  return <MachineNavigation><SettingsPage>{body}</SettingsPage></MachineNavigation>
}
