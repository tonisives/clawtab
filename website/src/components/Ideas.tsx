import { useState, useEffect } from "react"
import { Section } from "./Section"
import { HScrollWrapper } from "./HScrollWrapper"

type Idea = {
  business_idea_id: string
  title: string
  tagline: string
  representative_posts?: { quote: string }[]
  post_count?: number
  created_at: string
  evidence_strength?: { volume: number; urgency: number; specificity: number }
  validation_score?: number
}

type SignalInfo = {
  label: string
  color: string
  pct: number
}

export let Ideas = () => {
  let [ideas, setIdeas] = useState<Idea[]>([])
  let [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(TSKR_API)
      .then((r) => r.json())
      .then((res) => {
        if (!res.success || !res.data || !res.data.length) return
        let top = res.data
          .filter((i: Idea) => (i.post_count || 0) >= 10)
          .sort((a: Idea, b: Idea) => (b.post_count || 0) - (a.post_count || 0))
          .slice(0, 9)
        if (top.length) setIdeas(top)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <Section
      id="ideas"
      title="Looking for business ideas?"
      subtitle="Trending opportunities discovered by TrendSeeker -- validate demand before you build."
    >
      <HScrollWrapper showArrows>
        <div className="flex gap-5 overflow-x-auto snap-x snap-mandatory flex-1 min-w-0 hscroll-track">
          {loading
            ? [0, 1, 2].map((i) => <SkeletonCard key={i} />)
            : ideas.map((idea) => <IdeaCard key={idea.business_idea_id} idea={idea} />)}
        </div>
      </HScrollWrapper>
      <div className="text-center mt-8">
        <a
          href="https://www.trend-seeker.app"
          target="_blank"
          rel="noreferrer"
          className="inline-block px-7 py-3 rounded-lg text-[15px] font-semibold bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] no-underline transition-colors"
        >
          Open TrendSeeker
        </a>
      </div>
    </Section>
  )
}

let TSKR_API = "https://svc.trend-seeker.app/api/ideas?limit=50&sortBy=newest"

let signalInfo = (idea: Idea): SignalInfo => {
  let score = 0
  let ev = idea.evidence_strength
  if (ev && typeof ev.volume !== "undefined") {
    let vol = ev.volume || 0
    let urg = ev.urgency || 0
    let spec = ev.specificity || 0
    score = (vol + urg + spec) / 3
  } else if (idea.validation_score != null) {
    score = idea.validation_score || 0
  }
  if (score >= 0.95) return { label: "Hot Signal", color: "#ef5350", pct: score }
  if (score >= 0.9) return { label: "Strong", color: "#ff9800", pct: score }
  if (score >= 0.8) return { label: "Emerging", color: "#66bb6a", pct: score }
  return { label: "New", color: "#5c6bc0", pct: score }
}

let relDate = (d: string) => {
  let ms = Date.now() - new Date(d).getTime()
  let days = Math.floor(ms / 86400000)
  if (days < 1) return "today"
  if (days < 7) return days + "d ago"
  if (days < 30) return Math.floor(days / 7) + "w ago"
  return Math.floor(days / 30) + "mo ago"
}

let IdeaCard = ({ idea }: { idea: Idea }) => {
  let sig = signalInfo(idea)
  let quote = ""
  if (idea.representative_posts && idea.representative_posts.length > 0) {
    quote = idea.representative_posts[0].quote
    if (quote.length > 80) quote = quote.slice(0, 77) + "..."
  }
  let postCount = idea.post_count || 0

  return (
    <a
      href={`https://www.trend-seeker.app/ideas/${idea.business_idea_id}`}
      target="_blank"
      rel="noreferrer"
      className="idea-card flex-[0_0_calc((100%_-_40px)/3)] max-md:flex-[0_0_calc(100%_-_20px)] snap-center relative bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl overflow-hidden flex flex-col no-underline text-[var(--color-text)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_8px_24px_rgba(0,0,0,0.1)] dark:hover:shadow-[0_8px_24px_rgba(0,0,0,0.3)]"
      style={{ "--signal-color": sig.color } as React.CSSProperties}
    >
      <div className="h-[3px] w-full shrink-0" style={{ background: sig.color }} />
      <IdeaCardBody idea={idea} sig={sig} quote={quote} postCount={postCount} />
    </a>
  )
}

let IdeaCardBody = ({
  idea,
  sig,
  quote,
  postCount,
}: {
  idea: Idea
  sig: SignalInfo
  quote: string
  postCount: number
}) => (
  <div className="p-5 flex flex-col gap-3 flex-1">
    <span
      className="inline-flex self-start text-[11px] font-semibold px-2.5 py-0.5 rounded-xl"
      style={{ background: sig.color + "15", color: sig.color }}
    >
      {sig.label}
    </span>
    <h3 className="text-[17px] font-semibold leading-snug line-clamp-2 m-0">{idea.title}</h3>
    <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed line-clamp-2 m-0">
      {idea.tagline}
    </p>
    {quote && (
      <div className="text-[13px] italic text-[var(--color-text-secondary)] leading-relaxed p-2.5 rounded-lg bg-[rgba(0,0,0,0.02)] dark:bg-[rgba(255,255,255,0.03)] line-clamp-2">
        &ldquo;{quote}&rdquo;
      </div>
    )}
    <SignalMeter sig={sig} />
    <div className="flex justify-between items-center pt-2.5 text-xs text-[var(--color-text-secondary)] border-t border-[rgba(0,0,0,0.04)] dark:border-[rgba(255,255,255,0.06)]">
      <span>
        {postCount} signal{postCount !== 1 ? "s" : ""}
      </span>
      <span>{relDate(idea.created_at)}</span>
    </div>
  </div>
)

let SignalMeter = ({ sig }: { sig: SignalInfo }) => (
  <div className="mt-auto">
    <div className="flex justify-between items-center mb-1.5 text-xs text-[var(--color-text-secondary)]">
      <span>Signal Strength</span>
      <span style={{ color: sig.color, fontWeight: 600 }}>{Math.round(sig.pct * 100)}%</span>
    </div>
    <div className="h-1 rounded-sm overflow-hidden bg-[rgba(0,0,0,0.06)] dark:bg-[rgba(255,255,255,0.08)]">
      <div
        className="h-full rounded-sm transition-[width] duration-500"
        style={{ width: sig.pct * 100 + "%", background: sig.color }}
      />
    </div>
  </div>
)

let SkeletonCard = () => (
  <div className="idea-card flex-[0_0_calc((100%_-_40px)/3)] max-md:flex-[0_0_calc(100%_-_20px)] snap-center relative bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl overflow-hidden min-h-[280px]">
    <div className="shimmer w-full h-full" />
  </div>
)
