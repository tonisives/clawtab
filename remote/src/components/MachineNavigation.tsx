import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigation, useRoute } from "expo-router/react-navigation"
import { MachineNavigationProvider, useMachineNavigation, type MachineOnboardingContent } from "../../../shared/src/machines/Onboarding"
import { SettingsPage } from "./settings/SettingsPage"

type MachinePage = { title: string; content: MachineOnboardingContent }
export type MachinePageParams = { id: string; title: string }
type Navigation = { push: (name: "machine-page", params: MachinePageParams) => void; goBack: () => void }
let pages = new Map<string, MachinePage>()
let nextPage = 0
let PageHistory = createContext<{ back: () => void; pages: Set<string> } | null>(null)

// Browser Forward can revisit a popped machine page while Settings is mounted.
export let MachinePageHistoryProvider = ({ children, onBack }: { children: ReactNode; onBack?: () => void }) => {
  let retained = useRef(new Set<string>()).current
  useEffect(() => () => { for (let id of retained) pages.delete(id) }, [retained])
  return <PageHistory.Provider value={onBack ? { back: onBack, pages: retained } : null}>{children}</PageHistory.Provider>
}

export let MachineNavigation = ({ children }: { children: ReactNode }) => {
  let navigation = useNavigation<Navigation>()
  let parent = useMachineNavigation()
  let history = useContext(PageHistory)
  let push = (page: MachinePage) => {
    let id = String(++nextPage)
    pages.set(id, page)
    history?.pages.add(id)
    navigation.push("machine-page", { id, title: page.title })
  }
  return <MachineNavigationProvider value={parent ?? { push }}>{children}</MachineNavigationProvider>
}

export let MachinePageScreen = () => {
  let navigation = useNavigation<Navigation>()
  let route = useRoute() as { params: MachinePageParams }
  let [page] = useState(() => pages.get(route.params.id))
  let history = useContext(PageHistory)
  useEffect(() => () => { if (!history) pages.delete(route.params.id) }, [route.params.id, history])
  let close = history?.back ?? (() => navigation.goBack())
  let body = typeof page?.content === "function" ? page.content(close) : page?.content
  return <MachineNavigation><SettingsPage>{body}</SettingsPage></MachineNavigation>
}
