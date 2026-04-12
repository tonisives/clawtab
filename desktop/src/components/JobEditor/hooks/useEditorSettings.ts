import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessProvider } from "@clawtab/shared";
import type { AppSettings, Job } from "../../../types";

interface UseEditorSettingsParams {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  isWizard: boolean;
}

export function useEditorSettings({ form, setForm, isNew, isWizard }: UseEditorSettingsParams) {
  const [availableProviders, setAvailableProviders] = useState<ProcessProvider[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<ProcessProvider>("claude");
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const [telegramChats, setTelegramChats] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
      setDefaultProvider(s.default_provider);
      if (isWizard && !form.folder_path) {
        const workDir = (s.default_work_dir || "~").replace(/\/+$/, "");
        setForm((prev) => ({ ...prev, folder_path: workDir }));
      }
      if (isNew && s.default_tmux_session) {
        setForm((prev) => ({ ...prev, tmux_session: s.default_tmux_session }));
      }
      if (s.telegram?.chat_ids?.length) {
        const chats = s.telegram.chat_ids.map((id) => ({
          id,
          name: s.telegram?.chat_names?.[String(id)] ?? "",
        }));
        setTelegramChats(chats);
        if (form.telegram_chat_id === null) {
          setForm((prev) => ({
            ...prev,
            telegram_chat_id: chats[0].id,
            ...(isNew ? { notify_target: "telegram" as const } : {}),
          }));
        }
      }
    });
    invoke<ProcessProvider[]>("detect_agent_providers").then(setAvailableProviders).catch(() => {});
  }, []);

  const persistTmuxSession = (val: string) => {
    invoke<AppSettings>("get_settings").then((s) => {
      invoke("set_settings", { newSettings: { ...s, default_tmux_session: val } }).catch(() => {});
    }).catch(() => {});
  };

  return {
    availableProviders,
    defaultProvider,
    preferredEditor,
    telegramChats,
    persistTmuxSession,
  };
}
