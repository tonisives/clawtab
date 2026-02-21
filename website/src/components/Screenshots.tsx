import { Section } from "./Section"
import { HScrollWrapper } from "./HScrollWrapper"

export let Screenshots = () => (
  <Section id="screenshots" title="See It in Action">
    <HScrollWrapper showArrows maxWidth="800px" itemCount={screenshots.length} itemsPerView={1}>
      <div className="flex snap-x snap-mandatory">
        {screenshots.map((s) => (
          <ScreenshotSlide key={s.src} src={s.src} caption={s.caption} />
        ))}
      </div>
    </HScrollWrapper>
  </Section>
)

let screenshots = [
  { src: "/assets/screenshot-gui.png", caption: "Jobs panel with live output monitoring" },
  { src: "/assets/screenshot-telegram.png", caption: "Telegram notifications and remote control" },
  {
    src: "/assets/screenshot-telegram-logs.png",
    caption: "Full Claude Code output in Telegram",
  },
]

let ScreenshotSlide = ({ src, caption }: { src: string; caption: string }) => (
  <div className="flex-[0_0_100%] min-w-0 text-center snap-center px-1">
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-1.5 shadow-[0_2px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
      <img src={src} alt={caption} loading="lazy" className="w-full block rounded-lg" />
    </div>
    <p className="text-sm text-[var(--color-text-secondary)] mt-3">{caption}</p>
  </div>
)
