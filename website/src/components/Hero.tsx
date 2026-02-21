export let Hero = () => (
  <section className="relative text-center pt-20 pb-16 px-6 max-w-[1080px] mx-auto overflow-hidden">
    <div
      className="absolute inset-0 bg-center bg-cover bg-no-repeat opacity-[0.07] dark:opacity-[0.05] pointer-events-none"
      style={{ backgroundImage: "url(/assets/hero-bg.png)" }}
    />
    <div className="relative">
    <img
      src="/assets/app-icon.png"
      alt="ClawTab"
      className="w-32 h-32 rounded-[28px] mb-8 inline-block"
    />
    <h1 className="text-5xl font-bold tracking-[-0.02em] leading-[1.1] mb-4 max-md:text-[32px]">
      Schedule Claude Code agents from your menu bar
    </h1>
    <p className="text-xl text-[var(--color-text-secondary)] max-w-[560px] mx-auto mb-8 max-md:text-[17px]">
      A macOS app for running automated Claude Code jobs, shell scripts, and project-based AI agents
      on a cron schedule, all orchestrated through tmux.
    </p>
    <div className="flex gap-3 justify-center mb-12">
      <a
        href="#install"
        className="inline-block px-7 py-3 rounded-lg text-[15px] font-semibold bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] no-underline transition-all hover:-translate-y-0.5"
      >
        Install
      </a>
      <a
        href="/docs"
        className="inline-block px-7 py-3 rounded-lg text-[15px] font-semibold bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] no-underline transition-all hover:-translate-y-0.5"
      >
        Read the Docs
      </a>
    </div>
    <div className="max-w-[800px] mx-auto rounded-xl overflow-hidden border border-[var(--color-border)] shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
      <video autoPlay loop muted playsInline className="w-full block">
        <source src="/assets/hero-demo.mp4" type="video/mp4" />
      </video>
    </div>
    </div>
  </section>
)
