type SectionProps = {
  id?: string
  title: string
  subtitle?: string
  children: React.ReactNode
}

export let Section = ({ id, title, subtitle, children }: SectionProps) => (
  <section className="py-16 px-6 max-w-[1080px] mx-auto" id={id}>
    <h2 className="text-[32px] font-bold text-center mb-3 tracking-[-0.01em]">{title}</h2>
    {subtitle && (
      <p className="text-[17px] text-[var(--color-text-secondary)] text-center mb-12 max-w-[560px] mx-auto leading-relaxed">
        {subtitle}
      </p>
    )}
    {children}
  </section>
)
