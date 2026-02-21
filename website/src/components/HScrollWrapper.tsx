import { useRef } from "react"

type HScrollWrapperProps = {
  children: React.ReactNode
  showArrows?: boolean
}

export let HScrollWrapper = ({ children, showArrows = false }: HScrollWrapperProps) => {
  let trackRef = useRef<HTMLDivElement>(null)

  let scroll = (dir: number) => {
    let track = trackRef.current
    if (!track) return
    let cards = Array.from(
      track.querySelectorAll<HTMLElement>(".use-case-card, .idea-card, .gallery-slide"),
    ).filter((c) => c.offsetWidth > 0)
    let card = cards[0]
    if (!card) return
    let gap = parseFloat(getComputedStyle(track).gap) || 20
    let step = card.offsetWidth + gap
    let count = window.innerWidth <= 768 ? 1 : 3
    let delta = step * count * dir

    if (dir > 0 && track.scrollLeft + track.clientWidth >= track.scrollWidth - 1) {
      track.scrollTo({ left: 0, behavior: "smooth" })
    } else if (dir < 0 && track.scrollLeft <= 1) {
      track.scrollTo({ left: track.scrollWidth, behavior: "smooth" })
    } else {
      track.scrollBy({ left: delta, behavior: "smooth" })
    }
  }

  return (
    <div className="relative flex items-center gap-3">
      {showArrows && <ScrollArrow direction="left" onClick={() => scroll(-1)} />}
      <div ref={trackRef}>{children}</div>
      {showArrows && <ScrollArrow direction="right" onClick={() => scroll(1)} />}
    </div>
  )
}

let ScrollArrow = ({
  direction,
  onClick,
}: {
  direction: "left" | "right"
  onClick: () => void
}) => (
  <button
    onClick={onClick}
    aria-label={direction === "left" ? "Previous" : "Next"}
    className="shrink-0 w-11 h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-[22px] cursor-pointer flex items-center justify-center transition-colors hover:bg-[var(--color-border)] z-[2]"
  >
    {direction === "left" ? "\u2039" : "\u203A"}
  </button>
)
