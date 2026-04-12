import { useState } from "react";
import { STEPS, type WizardStep } from "../types";

export function useWizardNavigation() {
  const [currentStep, setCurrentStep] = useState<WizardStep>("identity");
  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const [scheduleExpanded, setScheduleExpanded] = useState(true);
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [telegramExpanded, setTelegramExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  const goNext = () => {
    if (currentIdx < STEPS.length - 1) {
      setCurrentStep(STEPS[currentIdx + 1].id);
    }
  };

  const goBack = () => {
    if (currentIdx > 0) {
      setCurrentStep(STEPS[currentIdx - 1].id);
    }
  };

  return {
    currentStep,
    setCurrentStep,
    currentIdx,
    expandedCategory,
    setExpandedCategory,
    scheduleExpanded,
    setScheduleExpanded,
    secretsExpanded,
    setSecretsExpanded,
    skillsExpanded,
    setSkillsExpanded,
    telegramExpanded,
    setTelegramExpanded,
    advancedExpanded,
    setAdvancedExpanded,
    goNext,
    goBack,
  };
}
