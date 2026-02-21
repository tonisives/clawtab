import { useState, useEffect, useCallback, useRef } from "react"

let CONTENT_ID = "docs-content"

let scriptsReady: Promise<void> | null = null

function ensureScripts(): Promise<void> {
  if (scriptsReady) return scriptsReady
  scriptsReady = new Promise((resolve) => {
    let loaded = 0
    let check = () => { if (++loaded === 2) resolve() }

    let markedScript = document.createElement("script")
    markedScript.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js"
    markedScript.onload = check
    document.head.appendChild(markedScript)

    let mermaidScript = document.createElement("script")
    mermaidScript.src = "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"
    mermaidScript.onload = () => {
      let w = window as any
      w.mermaid.initialize({ startOnLoad: false, theme: "dark" })
      check()
    }
    document.head.appendChild(mermaidScript)
  })
  return scriptsReady
}

async function renderMermaid(container: HTMLElement) {
  let w = window as any
  if (!w.mermaid) return
  let blocks = container.querySelectorAll("code.language-mermaid")
  for (let i = 0; i < blocks.length; i++) {
    let code = blocks[i] as HTMLElement
    let pre = code.parentElement
    if (!pre || pre.tagName !== "PRE") continue
    let id = `mermaid-${Date.now()}-${i}`
    let { svg } = await w.mermaid.render(id, code.textContent || "")
    let div = document.createElement("div")
    div.className = "mermaid"
    div.innerHTML = svg
    pre.replaceWith(div)
  }
}

export let Docs = () => {
  let [activeDoc, setActiveDoc] = useState(() => {
    let hash = window.location.hash.slice(1)
    let found = docPages.find((d) => d.hash === hash)
    return found ? found.file : docPages[0].file
  })
  let [content, setContent] = useState("Loading documentation...")
  let [ready, setReady] = useState(false)
  let mainRef = useRef<HTMLElement>(null)

  let loadDoc = useCallback(async (filename: string) => {
    try {
      let resp = await fetch(RAW_BASE + filename)
      if (!resp.ok) throw new Error(resp.statusText)
      let md = await resp.text()
      let w = window as any
      if (w.marked) {
        setContent(w.marked.parse(md))
      } else {
        setContent(`<pre>${md}</pre>`)
      }
    } catch (e) {
      setContent(`<p>Failed to load ${filename}: ${(e as Error).message}</p>`)
    }
  }, [])

  useEffect(() => {
    ensureScripts().then(() => {
      setReady(true)
      loadDoc(activeDoc)
    })
  }, [])

  useEffect(() => {
    if (ready) loadDoc(activeDoc)
  }, [activeDoc, ready, loadDoc])

  useEffect(() => {
    if (mainRef.current) renderMermaid(mainRef.current)
  }, [content])

  let handleNav = useCallback(
    (file: string, hash: string) => {
      setActiveDoc(file)
      window.history.replaceState(null, "", "#" + hash)
      let el = document.getElementById(CONTENT_ID)
      if (el) {
        let navHeight = 56
        let top = el.getBoundingClientRect().top + window.scrollY - navHeight
        window.scrollTo({ top, behavior: "instant" })
      }
    },
    [],
  )

  return (
    <div className="max-w-[1080px] mx-auto px-6">
      <div className="w-full h-40 overflow-hidden rounded-xl mb-6 mt-4 flex items-center">
        <img
          src="/assets/docs-hero.png"
          alt="ClawTab Documentation"
          className="w-full block object-cover object-center"
        />
      </div>
      <div id={CONTENT_ID} className="grid grid-cols-[220px_1fr] gap-8 pb-8 min-h-[calc(100vh-56px)] max-md:grid-cols-1">
        <Sidebar docPages={docPages} activeDoc={activeDoc} onNav={handleNav} />
        <main
          ref={mainRef}
          className="min-w-0 docs-content"
          dangerouslySetInnerHTML={{ __html: content }}
        />
      </div>
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
