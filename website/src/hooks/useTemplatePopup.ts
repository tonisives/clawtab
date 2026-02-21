import { useState } from "react"

export let useTemplatePopup = () => {
  let [activeTemplate, setActiveTemplate] = useState<string | null>(null)
  let show = (templateId: string) => setActiveTemplate(templateId)
  let hide = () => setActiveTemplate(null)
  return { activeTemplate, show, hide }
}
