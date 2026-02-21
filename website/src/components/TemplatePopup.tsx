type TemplatePopupProps = {
  templateId: string
  onClose: () => void
}

export let TemplatePopup = ({ templateId, onClose }: TemplatePopupProps) => (
  <div
    className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center backdrop-blur-[4px]"
    onClick={onClose}
  >
    <div
      className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-8 max-w-[420px] w-[calc(100%-48px)] shadow-[0_16px_48px_rgba(0,0,0,0.2)] dark:shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
      onClick={(e) => e.stopPropagation()}
    >
      <h3 className="text-xl font-bold mb-1">Use this template</h3>
      <p className="text-sm text-[var(--color-text-secondary)] mb-6">
        Get started with this automation in ClawTab.
      </p>
      <div className="flex flex-col gap-1 mb-6">
        <a
          href={`clawtab://template/${templateId}`}
          className="flex flex-col gap-0.5 p-3.5 rounded-lg cursor-pointer transition-colors bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] no-underline text-[var(--color-text)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
        >
          <strong className="text-sm font-semibold text-[var(--color-accent)]">
            Open in ClawTab
          </strong>
          <span className="text-xs text-[var(--color-text-secondary)]">
            Launch the app and create this job
          </span>
        </a>
        <p className="text-[11px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider px-4 pt-3 pb-1 m-0 border-t border-[var(--color-border)]">
          Install ClawTab
        </p>
        <a
          href="https://github.com/tonisives/clawtab"
          target="_blank"
          rel="noreferrer"
          className="flex flex-col gap-0.5 p-3.5 rounded-lg cursor-pointer transition-colors no-underline text-[var(--color-text)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
        >
          <strong className="text-sm font-semibold">View on GitHub</strong>
          <span className="text-xs text-[var(--color-text-secondary)]">
            Clone the repo and build from source
          </span>
        </a>
        <div className="flex flex-col gap-0.5 p-3.5 rounded-lg transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-accent)_4%,transparent)]">
          <strong className="text-sm font-semibold">Install via Homebrew</strong>
          <code className="font-mono text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 mt-1 block select-all">
            brew install --cask tonisives/tap/clawtab
          </code>
        </div>
      </div>
      <button
        onClick={onClose}
        className="block w-full p-2.5 text-sm font-medium text-[var(--color-text-secondary)] bg-transparent border border-[var(--color-border)] rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
      >
        Close
      </button>
    </div>
  </div>
)
