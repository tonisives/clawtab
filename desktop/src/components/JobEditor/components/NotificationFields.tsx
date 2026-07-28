import type { Job, NotifyTarget } from "../../../types";

type NotificationKey = keyof Job["telegram_notify"];

type NotificationOption = {
  key: NotificationKey;
  label: string;
  hint: string;
};

type NotificationFieldsProps = {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  telegramChats: { id: number; name: string }[];
};

type NotificationCheckboxesProps = {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  label: string;
};

const NOTIFICATION_OPTIONS: NotificationOption[] = [
  { key: "start", label: "Job started", hint: "Notify when the job begins" },
  { key: "working", label: "Working timer", hint: "Live elapsed time counter" },
  { key: "logs", label: "Log output", hint: "Stream pane output while running" },
  { key: "finish", label: "Job finished", hint: "Send a completion message" },
];

const NotificationCheckboxes = ({ form, setForm, label }: NotificationCheckboxesProps) => {
  const handleNotificationChange = (key: NotificationKey, enabled: boolean) => {
    setForm((prev) => ({
      ...prev,
      telegram_notify: { ...prev.telegram_notify, [key]: enabled },
    }));
  };

  return (
    <div className="form-group">
      <label>{label}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
        {NOTIFICATION_OPTIONS.map(({ key, label: optionLabel, hint }) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={form.telegram_notify[key]}
              onChange={(e) => handleNotificationChange(key, e.target.checked)}
              style={{ margin: 0 }}
            />
            <span>{optionLabel}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>{hint}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

export const NotificationFields = ({ form, setForm, telegramChats }: NotificationFieldsProps) => {
  const selectedTelegramChatId = form.telegram_chat_id;
  const hasSavedChat = selectedTelegramChatId != null && telegramChats.some((chat) => chat.id === selectedTelegramChatId);
  const selectableTelegramChats = selectedTelegramChatId != null && !hasSavedChat
    ? [{ id: selectedTelegramChatId, name: "Saved chat" }, ...telegramChats]
    : telegramChats;

  return (
    <>
      <div className="form-group">
        <label>Notification Target</label>
        <div style={{ display: "flex", gap: 8, padding: "4px 0" }}>
          {([
            { value: "none" as NotifyTarget, label: "None" },
            { value: "app" as NotifyTarget, label: "App" },
            { value: "telegram" as NotifyTarget, label: "Telegram" },
          ]).map(({ value, label }) => (
            <label key={value} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
              <input
                type="radio"
                name="notify_target"
                checked={form.notify_target === value}
                onChange={() => setForm((prev) => ({ ...prev, notify_target: value }))}
                style={{ margin: 0 }}
              />
              {label}
            </label>
          ))}
        </div>
        <span className="hint">
          {form.notify_target === "none" && "No push notifications for this job"}
          {form.notify_target === "app" && "Push notifications via ClawTab mobile app"}
          {form.notify_target === "telegram" && "Notifications sent to Telegram bot"}
        </span>
      </div>

      {form.notify_target === "telegram" && (
        <>
          <div className="form-group">
            <label>Telegram Chat</label>
            {selectableTelegramChats.length > 0 ? (
              <select
                value={form.telegram_chat_id ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((prev) => ({ ...prev, telegram_chat_id: val ? parseInt(val, 10) : null }));
                }}
              >
                <option value="">Default chat</option>
                {selectableTelegramChats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.name ? `${chat.name} (${chat.id})` : String(chat.id)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={form.telegram_chat_id ?? ""}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  setForm((prev) => ({ ...prev, telegram_chat_id: val ? parseInt(val, 10) || null : null }));
                }}
                placeholder=""
              />
            )}
            <span className="hint">
              {selectableTelegramChats.length > 0
                ? "Select a chat for this job, or use the configured default"
                : "Configure telegram in Settings to add chats"}
            </span>
          </div>

          <NotificationCheckboxes form={form} setForm={setForm} label="Telegram Notifications" />
        </>
      )}

      {form.notify_target === "app" && (
        <>
          <NotificationCheckboxes form={form} setForm={setForm} label="App Notifications" />
          <div className="form-group">
            <span className="hint">
              Push notifications sent to ClawTab mobile app. Download at remote.clawtab.cc
            </span>
          </div>
        </>
      )}
    </>
  );
};
