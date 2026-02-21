import { Section } from "./Section"
import { features, icons } from "../data/features"

export let Features = () => (
  <Section
    id="features"
    title="Features"
    subtitle="Everything you need to automate Claude Code and shell jobs on macOS."
  >
    <div className="grid grid-cols-3 gap-5 max-md:grid-cols-1">
      {features.map((f) => (
        <FeatureCard key={f.title} title={f.title} desc={f.desc} icon={f.icon} />
      ))}
    </div>
  </Section>
)

let FeatureCard = ({ title, desc, icon }: { title: string; desc: string; icon: string }) => (
  <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl py-7 px-6">
    <div className="w-11 h-11 rounded-[10px] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] flex items-center justify-center mb-4">
      {icons[icon]}
    </div>
    <h3 className="text-[17px] font-semibold mb-2">{title}</h3>
    <p className="text-sm text-[var(--color-text-secondary)] leading-normal">{desc}</p>
  </div>
)
