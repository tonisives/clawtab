import { Hero } from "../components/Hero"
import { Features } from "../components/Features"
import { HowItWorks } from "../components/HowItWorks"
import { UseCases } from "../components/UseCases"
import { Screenshots } from "../components/Screenshots"
import { Install } from "../components/Install"
import { Ideas } from "../components/Ideas"
import { TemplatePopup } from "../components/TemplatePopup"
import { useTemplatePopup } from "../hooks/useTemplatePopup"

export let Landing = () => {
  let { activeTemplate, show, hide } = useTemplatePopup()

  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <UseCases onUseTemplate={show} />
      <Screenshots />
      <Install />
      <Ideas />
      {activeTemplate && <TemplatePopup templateId={activeTemplate} onClose={hide} />}
    </>
  )
}
