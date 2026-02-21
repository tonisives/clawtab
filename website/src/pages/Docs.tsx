import { useState, useEffect, useCallback } from "react"

export let Docs = () => {
  let [activeDoc, setActiveDoc] = useState(() => {
    let hash = window.location.hash.slice(1)
    let found = docPages.find((d) => d.hash === hash)
    return found ? found.file : docPages[0].file
  })
  let [content, setContent] = useState("Loading documentation...")
  let [loaded, setLoaded] = useState(false)

  let loadDoc = useCallback(async (filename: string) => {
    try {
      let resp = await fetch("/docs/" + filename)
      if (!resp.ok) {
        resp = await fetch(RAW_BASE + filename)
      }
      if (!resp.ok) throw new Error(resp.statusText)
      let md = await resp.text()
      let w = window as unknown as { marked?: { parse: (md: string) => string } }
      if (w.marked) {
        setContent(w.marked.parse(md))
      } else {
        setContent(`<pre>${md}</pre>`)
      }
      setLoaded(true)
    } catch (e) {
      setContent(`<p>Failed to load ${filename}: ${(e as Error).message}</p>`)
    }
  }, [])

  useEffect(() => {
    let script = document.createElement("script")
    script.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js"
    script.onload = () => loadDoc(activeDoc)
    document.head.appendChild(script)
    return () => {
      document.head.removeChild(script)
    }
  }, [])

  useEffect(() => {
    if (loaded) loadDoc(activeDoc)
  }, [activeDoc, loaded, loadDoc])

  let handleNav = useCallback(
    (file: string, hash: string) => {
      setActiveDoc(file)
      window.history.replaceState(null, "", "#" + hash)
      window.scrollTo(0, 0)
    },
    [],
  )

  return (
    <div className="grid grid-cols-[220px_1fr] gap-8 max-w-[1080px] mx-auto px-6 py-8 min-h-[calc(100vh-56px)] max-md:grid-cols-1">
      <Sidebar docPages={docPages} activeDoc={activeDoc} onNav={handleNav} />
      <main
        className="min-w-0 docs-content"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    </div>
  )
}

let docPages = [
  { hash: "quick-start", file: "quick-start.md", label: "Quick Start" },
  { hash: "configuration", file: "configuration.md", label: "Configuration" },
  { hash: "job-types", file: "job-types.md", label: "Job Types" },
  { hash: "secrets", file: "secrets.md", label: "Secrets" },
  { hash: "telegram", file: "telegram.md", label: "Telegram" },
  { hash: "cli-tui", file: "cli-tui.md", label: "CLI & TUI" },
  { hash: "architecture", file: "architecture.md", label: "Architecture" },
  { hash: "file-reference", file: "file-reference.md", label: "File Reference" },
]

let RAW_BASE = "https://raw.githubusercontent.com/tonisives/clawtab/main/docs/"

type DocPage = { hash: string; file: string; label: string }

let Sidebar = ({
  docPages,
  activeDoc,
  onNav,
}: {
  docPages: DocPage[]
  activeDoc: string
  onNav: (file: string, hash: string) => void
}) => (
  <aside className="sticky top-[calc(56px+24px)] self-start max-h-[calc(100vh-56px-48px)] overflow-y-auto max-md:static max-md:max-h-none">
    <ul className="list-none">
      {docPages.map((d) => (
        <SidebarItem
          key={d.hash}
          doc={d}
          isActive={activeDoc === d.file}
          onNav={onNav}
        />
      ))}
    </ul>
  </aside>
)

let SidebarItem = ({
  doc,
  isActive,
  onNav,
}: {
  doc: DocPage
  isActive: boolean
  onNav: (file: string, hash: string) => void
}) => {
  let handleClick = useCallback(() => {
    onNav(doc.file, doc.hash)
  }, [onNav, doc.file, doc.hash])

  return (
    <li>
      <button
        onClick={handleClick}
        className={`block w-full text-left px-3 py-1.5 rounded-[6px] text-sm border-none bg-transparent cursor-pointer transition-colors ${
          isActive
            ? "bg-[var(--color-bg-secondary)] text-[var(--color-text)] font-semibold"
            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
        }`}
      >
        {doc.label}
      </button>
    </li>
  )
}
