import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocalSearchParams, useRouter } from "expo-router"
import { MachineNavigationProvider, useMachineNavigation, type MachineOnboardingContent } from "../../../shared/src/machines/Onboarding"
import { SettingsPage } from "./settings/SettingsPage"

type MachinePage = { title: string; content: MachineOnboardingContent }
export type MachinePageParams = { id: string; title: string }
type Navigation = { push: (name: "machine-page", params: MachinePageParams) => void; goBack: () => void }
export let EmbeddedMachineNavigation = createContext<(Navigation & { params?: MachinePageParams }) | null>(null)
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
  let embedded = useContext(EmbeddedMachineNavigation)
  let router = useRouter()
  let parent = useMachineNavigation()
  let history = useContext(PageHistory)
  let push = (page: MachinePage) => {
    let id = String(++nextPage)
    pages.set(id, page)
    history?.pages.add(id)
    if (embedded) embedded.push("machine-page", { id, title: page.title })
    else router.push({ pathname: "/machine-page", params: { id, title: page.title } })
  }
  return <MachineNavigationProvider value={parent ?? { push }}>{children}</MachineNavigationProvider>
}

export let MachinePageScreen = () => {
  let embedded = useContext(EmbeddedMachineNavigation)
  let router = useRouter()
  let params = useLocalSearchParams<{ id: string; title: string }>()
  let id = embedded?.params?.id ?? params.id
  let [page] = useState(() => pages.get(id))
  let history = useContext(PageHistory)
  useEffect(() => () => { if (!history) pages.delete(id) }, [id, history])
  let close = history?.back ?? (() => embedded ? embedded.goBack() : router.back())
  let body = typeof page?.content === "function" ? page.content(close) : page?.content
  return <MachineNavigation><SettingsPage>{body}</SettingsPage></MachineNavigation>
}
