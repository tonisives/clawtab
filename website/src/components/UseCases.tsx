import { useState, useCallback, useMemo } from "react"
import { Section } from "./Section"
import { HScrollWrapper } from "./HScrollWrapper"
import { useCases, type UseCase, type Template } from "../data/useCases"

type UseCasesProps = {
  onUseTemplate: (templateId: string) => void
}

export let UseCases = ({ onUseTemplate }: UseCasesProps) => {
  let allCases = useMemo(() => useCases.flat(), [])

  return (
    <Section
      id="use-cases"
      title="What Can You Automate?"
      subtitle="Pre-built templates for common automation tasks. One click to create."
    >
      {/* Mobile: single horizontal scroll with pips */}
      <MobileUseCases cases={allCases} onUseTemplate={onUseTemplate} />
      {/* Desktop: rows */}
      <div className="hidden md:flex flex-col gap-4">
        {useCases.map((row, ri) => (
          <UseCaseRow key={ri} cases={row} onUseTemplate={onUseTemplate} />
        ))}
      </div>
    </Section>
  )
}

let MobileUseCases = ({
  cases,
  onUseTemplate,
}: {
  cases: UseCase[]
  onUseTemplate: (id: string) => void
}) => {
  let [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  let toggle = useCallback((idx: number) => {
    setExpandedIdx((prev) => (prev === idx ? null : idx))
  }, [])

  return (
    <div className="md:hidden">
      <HScrollWrapper itemCount={cases.length} itemsPerView={1}>
        <div className="flex gap-4">
          {cases.map((uc, i) => (
            <UseCaseCard
              key={uc.title}
              useCase={uc}
              index={i}
              isExpanded={expandedIdx === i}
              isCollapsed={false}
              onToggle={toggle}
              onUseTemplate={onUseTemplate}
              mobile
            />
          ))}
        </div>
      </HScrollWrapper>
    </div>
  )
}

let UseCaseRow = ({
  cases,
  onUseTemplate,
}: {
  cases: UseCase[]
  onUseTemplate: (id: string) => void
}) => {
  let [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  let toggle = useCallback(
    (idx: number) => {
      setExpandedIdx((prev) => (prev === idx ? null : idx))
    },
    [],
  )

  return (
    <div className="use-case-row flex gap-4 items-start flex-wrap">
      {cases.map((uc, i) => {
        let isExpanded = expandedIdx === i
        return (
          <UseCaseCard
            key={uc.title}
            useCase={uc}
            index={i}
            isExpanded={isExpanded}
            isCollapsed={false}
            onToggle={toggle}
            onUseTemplate={onUseTemplate}
          />
        )
      })}
    </div>
  )
}

let UseCaseCard = ({
  useCase,
  index,
  isExpanded,
  onToggle,
  onUseTemplate,
  mobile,
}: {
  useCase: UseCase
  index: number
  isExpanded: boolean
  isCollapsed: boolean
  onToggle: (idx: number) => void
  onUseTemplate: (id: string) => void
  mobile?: boolean
}) => {
  let handleToggle = useCallback(() => {
    onToggle(index)
  }, [onToggle, index])

  let handleBodyClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <div
      className={`use-case-card ${mobile ? "w-72 shrink-0 snap-center" : "flex-1 min-w-0"} bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl overflow-hidden cursor-pointer hover:border-[var(--color-accent)] ${
        isExpanded ? "border-[var(--color-accent)]" : ""
      }`}
      onClick={handleToggle}
    >
      <img
        src={useCase.image}
        alt={useCase.title}
        loading="lazy"
        className="w-full h-40 object-cover block border-b border-[var(--color-border)]"
      />
      <UseCaseHeader useCase={useCase} />
      <div
        className={`use-case-body-grid border-t border-[var(--color-border)] px-6 ${isExpanded ? "expanded" : ""}`}
        onClick={handleBodyClick}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col">
            {useCase.templates.map((t) => (
              <TemplateItem key={t.id} template={t} onUseTemplate={onUseTemplate} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

let UseCaseHeader = ({ useCase }: { useCase: UseCase }) => (
  <div className="flex items-start gap-4 p-5 px-6">
    <div>
      <h3 className="text-base font-semibold mb-1">{useCase.title}</h3>
      <p className="text-[13px] text-[var(--color-text-secondary)] leading-snug m-0">
        {useCase.desc}
      </p>
    </div>
    <span className="shrink-0 text-[11px] font-semibold text-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2 py-0.5 rounded-xl whitespace-nowrap">
      {useCase.templates.length} templates
    </span>
  </div>
)

let TemplateItem = ({
  template,
  onUseTemplate,
}: {
  template: Template
  onUseTemplate: (id: string) => void
}) => {
  let [expanded, setExpanded] = useState(false)

  let handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded((prev) => !prev)
  }, [])

  let handleUseTemplate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onUseTemplate(template.id)
    },
    [onUseTemplate, template.id],
  )

  return (
    <div
      className="flex flex-col cursor-pointer rounded-lg px-3 py-2.5 transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)]"
      onClick={handleToggle}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <strong className="text-[13px] font-semibold">{template.title}</strong>
          <span className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            {template.desc}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg)] px-1.5 py-0.5 rounded-[3px] border border-[var(--color-border)] whitespace-nowrap">
            {template.cron}
          </span>
        </div>
      </div>
      <div className={`template-item-body ${expanded ? "expanded" : ""}`}>
        <div className="overflow-hidden">
          <pre className="mt-2 mb-0">
            <code className="template-code expanded block bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap">
              {template.code}
            </code>
          </pre>
          <button
            className="self-start mt-2 mb-1 px-4 py-1.5 text-xs font-semibold text-white bg-[var(--color-accent)] border-none rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-accent-hover)]"
            onClick={handleUseTemplate}
          >
            Use Template
          </button>
        </div>
      </div>
    </div>
  )
}
