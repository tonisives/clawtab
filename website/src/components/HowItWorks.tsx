import { Section } from "./Section"

export let HowItWorks = () => (
  <Section
    id="how-it-works"
    title="How It Works"
    subtitle="Define jobs, schedule them, monitor from anywhere."
  >
    <div className="grid grid-cols-3 gap-8 max-md:grid-cols-1">
      {steps.map((s, i) => (
        <Step key={s.title} num={i + 1} title={s.title} desc={s.desc} />
      ))}
    </div>
  </Section>
)

let steps = [
  {
    title: "Define Jobs",
    desc: "Create jobs in the GUI: shell scripts, Claude Code prompts, or project folders with .cwt instructions.",
  },
  {
    title: "ClawTab Schedules",
    desc: "Jobs run on cron in tmux windows. Secrets are injected, output is captured, and status is tracked.",
  },
  {
    title: "Monitor Anywhere",
    desc: "Watch from the GUI, CLI, TUI, or Telegram. Get notifications on success or failure.",
  },
]

let Step = ({ num, title, desc }: { num: number; title: string; desc: string }) => (
  <div className="text-center">
    <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-accent)] text-white text-lg font-bold mb-4">
      {num}
    </div>
    <h3 className="text-[17px] font-semibold mb-2">{title}</h3>
    <p className="text-sm text-[var(--color-text-secondary)]">{desc}</p>
  </div>
)
