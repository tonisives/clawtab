import { useRef, useState, useEffect, useCallback } from "react"

type HScrollWrapperProps = {
  children: React.ReactNode
  showArrows?: boolean
  maxWidth?: string
  itemCount: number
  itemsPerView?: number
}

export let HScrollWrapper = ({
  children,
  showArrows = false,
  maxWidth,
  itemCount,
  itemsPerView = 1,
}: HScrollWrapperProps) => {
  let wrapperRef = useRef<HTMLDivElement>(null)
  let trackRef = useRef<HTMLDivElement>(null)
  let [activeIdx, setActiveIdx] = useState(0)
  let [trackWidth, setTrackWidth] = useState<number | undefined>(undefined)
  let totalPages = Math.max(1, Math.ceil(itemCount / itemsPerView))

  useEffect(() => {
    let el = wrapperRef.current
    if (!el) return
    let ro = new ResizeObserver((entries) => {
      let w = entries[0]?.contentRect.width
      if (w) setTrackWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  let updateActiveIdx = useCallback(() => {
    let track = trackRef.current
    if (!track) return
    let scrollLeft = track.scrollLeft
    let scrollWidth = track.scrollWidth - track.clientWidth
    if (scrollWidth <= 0) {
      setActiveIdx(0)
      return
    }
    let ratio = scrollLeft / scrollWidth
    let page = Math.round(ratio * (totalPages - 1))
    setActiveIdx(page)
  }, [totalPages])

  useEffect(() => {
    let track = trackRef.current
    if (!track) return
    track.addEventListener("scroll", updateActiveIdx, { passive: true })
    return () => track.removeEventListener("scroll", updateActiveIdx)
  }, [updateActiveIdx])

  let scrollToPage = useCallback(
    (page: number) => {
      let track = trackRef.current
      if (!track) return
      let scrollWidth = track.scrollWidth - track.clientWidth
      let target = (page / (totalPages - 1)) * scrollWidth
      track.scrollTo({ left: target, behavior: "smooth" })
    },
    [totalPages],
  )

  let scroll = useCallback(
    (dir: number) => {
      let next = activeIdx + dir
      if (next >= totalPages) next = 0
      else if (next < 0) next = totalPages - 1
      scrollToPage(next)
    },
    [activeIdx, totalPages, scrollToPage],
  )

  let handlePrev = useCallback(() => scroll(-1), [scroll])
  let handleNext = useCallback(() => scroll(1), [scroll])

  let wrapperStyle = maxWidth ? { maxWidth, margin: "0 auto" } : undefined

  return (
    <div ref={wrapperRef} style={wrapperStyle}>
      <div className="relative">
        {showArrows && <ScrollArrow direction="left" onClick={handlePrev} className="hidden md:flex absolute left-0 top-1/2 -translate-x-14 -translate-y-1/2" />}
        <div
          ref={trackRef}
          className="overflow-x-auto snap-x snap-mandatory hscroll-track"
          style={trackWidth ? { maxWidth: trackWidth } : undefined}
        >
          {children}
        </div>
        {showArrows && <ScrollArrow direction="right" onClick={handleNext} className="hidden md:flex absolute right-0 top-1/2 translate-x-14 -translate-y-1/2" />}
      </div>
      {totalPages > 1 && <Pips total={totalPages} active={activeIdx} onSelect={scrollToPage} />}
    </div>
  )
}

let Pips = ({
  total,
  active,
  onSelect,
}: {
  total: number
  active: number
  onSelect: (idx: number) => void
}) => (
  <div className="flex justify-center gap-2 mt-5">
    {Array.from({ length: total }, (_, i) => (
      <PipButton key={i} index={i} isActive={i === active} onSelect={onSelect} />
    ))}
  </div>
)

let PipButton = ({
  index,
  isActive,
  onSelect,
}: {
  index: number
  isActive: boolean
  onSelect: (idx: number) => void
}) => {
  let handleClick = useCallback(() => onSelect(index), [onSelect, index])
  return (
    <button
      onClick={handleClick}
      aria-label={`Page ${index + 1}`}
      className={`w-2.5 h-2.5 rounded-full border cursor-pointer p-0 transition-colors ${
        isActive
          ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
          : "bg-[var(--color-bg-secondary)] border-[var(--color-border)] hover:bg-[var(--color-border)]"
      }`}
    />
  )
}

let ScrollArrow = ({
  direction,
  onClick,
  className = "",
}: {
  direction: "left" | "right"
  onClick: () => void
  className?: string
}) => (
  <button
    onClick={onClick}
    aria-label={direction === "left" ? "Previous" : "Next"}
    className={`w-12 h-12 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] cursor-pointer items-center justify-center transition-colors hover:bg-[var(--color-border)] z-[2] ${className}`}
  >
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {direction === "left"
        ? <polyline points="13,4 7,10 13,16" />
        : <polyline points="7,4 13,10 7,16" />}
    </svg>
  </button>
)
