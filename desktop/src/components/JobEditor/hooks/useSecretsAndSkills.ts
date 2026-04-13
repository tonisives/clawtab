import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, SecretEntry } from "../../../types";
import type { WizardStep } from "../types";

interface UseSecretsAndSkillsParams {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isWizard: boolean;
  currentStep: WizardStep;
}

export function useSecretsAndSkills({ form, setForm, isWizard, currentStep }: UseSecretsAndSkillsParams) {
  const [availableSecrets, setAvailableSecrets] = useState<SecretEntry[] | null>(null);
  const [availableSkills, setAvailableSkills] = useState<{ name: string }[] | null>(null);
  const [secretSearch, setSecretSearch] = useState("");
  const [addSecretKey, setAddSecretKey] = useState("");
  const [addSecretValue, setAddSecretValue] = useState("");
  const [addSecretVisible, setAddSecretVisible] = useState(false);

  useEffect(() => {
    if (!isWizard || currentStep === "settings") {
      if (availableSecrets === null) {
        invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets);
      }
      if (availableSkills === null) {
        invoke<{ name: string }[]>("list_skills").then(setAvailableSkills).catch(() => setAvailableSkills([]));
      }
    }
  }, [currentStep, isWizard, availableSecrets, availableSkills]);

  const toggleSecret = (key: string) => {
    const keys = form.secret_keys.includes(key)
      ? form.secret_keys.filter((k) => k !== key)
      : [...form.secret_keys, key];
    setForm((prev) => ({ ...prev, secret_keys: keys }));
  };

  const toggleSkill = (name: string) => {
    const path = `~/.claude/skills/${name}/SKILL.md`;
    const paths = form.skill_paths.includes(path)
      ? form.skill_paths.filter((p) => p !== path)
      : [...form.skill_paths, path];
    setForm((prev) => ({ ...prev, skill_paths: paths }));
  };

  const handleAddSecretInline = async () => {
    const key = addSecretKey.trim();
    if (!key || !addSecretValue.trim()) return;
    try {
      await invoke("set_secret", { key, value: addSecretValue.trim() });
      setForm((prev) => ({
        ...prev,
        secret_keys: prev.secret_keys.includes(key) ? prev.secret_keys : [...prev.secret_keys, key],
      }));
      setAddSecretKey("");
      setAddSecretValue("");
      setAddSecretVisible(false);
      const loaded = await invoke<SecretEntry[]>("list_secrets");
      setAvailableSecrets(loaded);
    } catch (e) {
      console.error("Failed to add secret:", e);
    }
  };

  return {
    availableSecrets,
    availableSkills,
    secretSearch,
    setSecretSearch,
    addSecretKey,
    setAddSecretKey,
    addSecretValue,
    setAddSecretValue,
    addSecretVisible,
    setAddSecretVisible,
    toggleSecret,
    toggleSkill,
    handleAddSecretInline,
  };
}
