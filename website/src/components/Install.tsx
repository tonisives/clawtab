import { Section } from "./Section"

export let Install = () => (
  <Section
    id="install"
    title="Install"
    subtitle="Install via Homebrew or build from source."
  >
    <div className="max-w-[600px] mx-auto flex flex-col gap-5">
      <InstallBlock icon={<DownloadIcon />} title="Homebrew">
        <CodeBlock code="brew install --cask tonisives/tap/clawtab" />
      </InstallBlock>
      <BuildFromSource />
      <RuntimeDeps />
    </div>
  </Section>
)

let InstallBlock = ({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) => (
  <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-8">
    <InstallBlockHeader icon={icon} title={title} />
    {children}
  </div>
)

let InstallBlockHeader = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
  <div className="flex items-center gap-3 mb-4">
    <div className="w-9 h-9 rounded-lg bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)] flex items-center justify-center shrink-0">
      {icon}
    </div>
    <h3 className="text-[17px] font-semibold">{title}</h3>
  </div>
)

let CodeBlock = ({ code }: { code: string }) => (
  <pre className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-4 font-mono text-[13px] overflow-x-auto">
    <code>{code}</code>
  </pre>
)

let InlineCode = ({ children }: { children: string }) => (
  <code className="font-mono text-[13px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-1.5 py-px">
    {children}
  </code>
)

let BuildFromSource = () => (
  <InstallBlock icon={<HammerIcon />} title="Build from Source">
    <p className="text-sm text-[var(--color-text-secondary)] mb-3">
      Requires macOS 10.15+,{" "}
      <a href="https://rustup.rs/">Rust</a>,{" "}
      <a href="https://nodejs.org/">Node.js</a>, and{" "}
      <a href="https://pnpm.io/">pnpm</a>.
    </p>
    <div className="mb-4">
      <CodeBlock code={`git clone https://github.com/tonisives/clawdtab.git\ncd clawdtab\npnpm install\ncargo tauri build`} />
    </div>
    <p className="text-sm text-[var(--color-text-secondary)]">
      Produces three binaries: <InlineCode>clawtab</InlineCode> (GUI),{" "}
      <InlineCode>cwtctl</InlineCode> (CLI),{" "}
      <InlineCode>cwttui</InlineCode> (TUI).
    </p>
  </InstallBlock>
)

let RuntimeDeps = () => (
  <InstallBlock icon={<GearIcon />} title="Runtime Dependencies">
    <ul className="list-none p-0">
      <li className="text-sm text-[var(--color-text-secondary)] py-1 before:content-['-_']">
        tmux (for Claude Code and folder jobs)
      </li>
      <li className="text-sm text-[var(--color-text-secondary)] py-1 before:content-['-_']">
        Claude Code CLI (for AI jobs)
      </li>
    </ul>
  </InstallBlock>
)

let DownloadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 42.65 42.6" fill="currentColor">
    <g fillRule="nonzero" transform="scale(1,-1) translate(0,-42.6)">
      <path d="M5.99 3.95c-.3 0-.51-.21-.51-.54 0-.3.21-.51.51-.51h30.64c.32 0 .54.21.54.51 0 .32-.21.54-.54.54H21.55c.06.02.11.06.17.11l14.72 14.63c.19.19.37.34.37.62 0 .3-.24.52-.56.52-.19 0-.37-.09-.49-.22l-9.33-9.37-4.64-4.68.06 4.73v28.9c0 .3-.21.51-.54.51-.3 0-.51-.21-.51-.51V10.29l.04-4.73-4.62 4.68-9.3 9.37c-.13.13-.32.22-.49.22-.32 0-.56-.22-.56-.52 0-.28.17-.43.34-.62L20.93 4.06c.04-.04.1-.09.17-.11z" />
    </g>
  </svg>
)

let HammerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 61.32 71.13" fill="currentColor">
    <g fillRule="nonzero" transform="scale(1,-1) translate(0,-71.13)">
      <path d="M5.99 15c1.55-1.57 2.53-1.29 3.91.21l23.07 25.14.09-.06c1.1-1.1 2-1.25 3.09-.86l2.3.79 2.26-2.23-.11-.47c-.36-1.57-.13-2.39.97-3.52l1.91-1.96c.54-.56 1.27-.58 1.74-.1l7.48 7.45c.52.47.43 1.2-.1 1.74l-1.96 1.96c-1.1 1.1-1.93 1.31-3.52.95l-.47-.11-2.23 2.26.82 2.3c.39 1.1.28 2.04-.84 3.12l-5.91 5.84c-6.83 6.75-15.94 7.11-22.39.43-.71-.75-.75-1.55-.19-2.17.39-.45.84-.54 1.48-.41 4.1.84 8.47.45 11.56-2.26l-1.78-4.6c-.37-.94-.28-1.78.52-2.73L6.21 19.16c-1.5-1.35-1.8-2.58-.22-4.16zm14.44 38.67c6.75 6.79 15.25 5.35 21.01-.41l5.93-5.91c.69-.67.75-1.2.56-1.78l-1.03-3.2 3.05-3.03 1.35.3c.8.15 1.4.11 2.22-.69l2.17-2.19-7.54-7.54-2.17 2.19c-.82.8-.89 1.4-.7 2.19l.3 1.33-3.07 3.09-3.18-1.05c-.56-.19-1.1-.06-1.74.58l-5.2 5.2c-.67.67-.77 1.18-.56 1.76l2.19 5.41c-2.84 2.81-8.17 4.1-12.83 2.86-.3-.09-.64-.15-.86.13-.19.24-.17.52.07.75zM6.88 15.62c-1.44 1.44-.65 2.15.23 2.94l24.99 22.97 3.85-3.87L12.98 12.7c-.79-.88-1.5-1.7-2.94-.26z" />
    </g>
  </svg>
)

let GearIcon = () => (
  <svg width="20" height="20" viewBox="0 0 54.89 62.13" fill="currentColor">
    <g fillRule="nonzero" transform="scale(1,-1) translate(0,-62.13)">
      <path d="M27.44 10.1c.73 0 1.46.04 2.15.15l1.05-2c.19-.39.41-.49.94-.43.5.04.63.22.69.73l.32 2.21c1.38.32 2.75.82 4.02 1.46l1.65-1.46c.28-.32.54-.34 1.03-.13.37.19.45.41.37.95l-.43 2.15c1.18.79 2.28 1.7 3.29 2.77l2.02-.84c.37-.26.62-.19 1.03.23.39.37.39.6.04 1.01l-1.16 1.89c.84 1.16 1.59 2.43 2.15 3.7l2.23-.11c.49-.04.69.11.82.56.17.47.09.69-.3.99l-1.72 1.4c.39 1.33.6 2.77.71 4.23l2.11.67c.47.17.6.37.6.84 0 .45-.13.64-.6.84l-2.11.67c-.11 1.46-.34 2.88-.71 4.23l1.72 1.4c.37.24.41.45.3.94-.13.47-.32.6-.82.6l-2.23-.09c-.58 1.29-1.31 2.53-2.15 3.7l1.16 1.87c.3.39.3.64-.04 1.01-.41.47-.67.52-1.03.28l-2.02-.82c-1.01 1.03-2.11 1.95-3.29 2.75l.43 2.13c.09.54.02.75-.37.95-.49.26-.71.24-1.03-.12l-1.65-1.44c-1.27.6-2.64 1.1-4.02 1.42l-.32 2.23c-.06.52-.19.67-.69.73-.54.04-.75-.1-.94-.49l-1.05-1.98c-.69.06-1.42.13-2.15.13-.69 0-1.4-.06-2.11-.13l-1.05 2.02c-.17.34-.39.45-.94.41-.5-.06-.63-.22-.69-.73l-.32-2.19c-1.38-.37-2.75-.84-4.02-1.42l-1.63 1.42c-.37.32-.58.34-1.03.13-.39-.19-.47-.41-.39-.95l.43-2.13c-1.18-.8-2.28-1.72-3.27-2.75l-2.02.82c-.39.24-.62.19-1.05-.28-.34-.34-.34-.6-.06-.98l1.2-1.87c-.84-1.16-1.57-2.41-2.15-3.7l-2.26.09c-.49.02-.67-.13-.82-.58-.21-.49-.13-.71.3-.94l1.72-1.4c-.34-1.35-.6-2.77-.71-4.25l-2.11-.67c-.49-.17-.62-.41-.62-.84 0-.49.13-.67.62-.84l2.11-.69c.11-1.44.32-2.88.71-4.23l-1.72-1.4c-.39-.26-.45-.47-.3-.99.15-.45.32-.6.82-.56l2.26.11c.54-1.27 1.31-2.54 2.11-3.7l-1.14-1.89c-.32-.41-.32-.64.04-1.01.43-.45.67-.49 1.05-.26l2.02.84c1.01-1.07 2.09-1.98 3.27-2.77l-.43-2.15c-.09-.54-.02-.76.39-.95.49-.21.71-.19 1.03.13l1.63 1.46c1.27-.64 2.64-1.14 4.02-1.48l.32-2.19c.06-.52.19-.69.71-.73.54-.06.77.11.94.43l1.05 2c.66-.11 1.42-.15 2.11-.15z" />
    </g>
  </svg>
)
