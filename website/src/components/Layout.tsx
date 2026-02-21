import { useCallback } from "react"
import { Outlet, Link, useLocation } from "react-router-dom"

export let Layout = () => {
  let location = useLocation()
  let isHome = location.pathname === "/"

  return (
    <div className="min-h-screen flex flex-col">
      <Nav isHome={isHome} />
      <Outlet />
      <Footer />
    </div>
  )
}

let navItems = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#use-cases", label: "Use Cases" },
  { href: "#screenshots", label: "Screenshots" },
  { href: "#install", label: "Install" },
  { href: "#ideas", label: "Ideas" },
]

let Nav = ({ isHome }: { isHome: boolean }) => {
  let handleNavClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    let href = e.currentTarget.getAttribute("href")
    if (!href?.startsWith("#")) return
    e.preventDefault()
    let el = document.querySelector(href)
    if (el) el.scrollIntoView({ behavior: "smooth" })
  }, [])

  return (
    <nav className="sticky top-0 z-50 h-14 flex items-center justify-between px-6 bg-[color:color-mix(in_srgb,var(--color-bg)_80%,transparent)] backdrop-blur-[20px] backdrop-saturate-[180%] border-b border-[var(--color-border)]">
      <Link to="/" className="flex items-center gap-2.5 text-lg font-semibold text-[var(--color-text)] no-underline">
        <img src="/assets/app-icon.png" alt="ClawTab" className="w-7 h-7 rounded-[6px]" />
        ClawTab
      </Link>
      <div className="flex items-center gap-6">
        {isHome && (
          <ul className="hidden md:flex gap-6 list-none">
            {navItems.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  onClick={handleNavClick}
                  className="text-[var(--color-text-secondary)] text-sm font-medium hover:text-[var(--color-text)] no-underline transition-colors"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        )}
        <Link
          to="/docs"
          className="text-[var(--color-text)] text-[13px] font-medium px-3.5 py-1.5 rounded-[6px] bg-[var(--color-border)] hover:bg-[color:color-mix(in_srgb,var(--color-border)_80%,var(--color-text)_20%)] no-underline transition-colors"
        >
          Docs
        </Link>
      </div>
    </nav>
  )
}

let Footer = () => (
  <footer className="text-center py-8 border-t border-[var(--color-border)] text-[var(--color-text-secondary)] text-[13px]">
    <p>Built with Tauri, React, and Rust.</p>
  </footer>
)
