import type { Job, NotifyTarget } from "../../../types";

interface NotificationFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  telegramChats: { id: number; name: string }[];
}

export function NotificationFields({ form, setForm, telegramChats }: NotificationFieldsProps) {
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
            {telegramChats.length > 0 ? (
              <select
                value={form.telegram_chat_id ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((prev) => ({ ...prev, telegram_chat_id: val ? parseInt(val, 10) : null }));
                }}
              >
                <option value="">None</option>
                {telegramChats.map((chat) => (
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
              {telegramChats.length > 0
                ? "Select which chat receives notifications for this job"
                : "Configure telegram in Settings to add chats"}
            </span>
          </div>

          {form.telegram_chat_id != null && (
            <div className="form-group">
              <label>Telegram Notifications</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
                {([
                  { key: "start" as const, label: "Job started", hint: "Notify when the job begins" },
                  { key: "working" as const, label: "Working timer", hint: "Live elapsed time counter" },
                  { key: "logs" as const, label: "Log output", hint: "Stream pane output while running" },
                  { key: "finish" as const, label: "Job finished", hint: "Final snapshot and completion message" },
                ] as const).map(({ key, label, hint }) => (
                  <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={form.telegram_notify[key]}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          telegram_notify: { ...prev.telegram_notify, [key]: e.target.checked },
                        }))
                      }
                      style={{ margin: 0 }}
                    />
                    <span>{label}</span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>{hint}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {form.notify_target === "app" && (
        <div className="form-group">
          <span className="hint">
            Push notifications sent to ClawTab mobile app. Download at remote.clawtab.cc
          </span>
        </div>
      )}
    </>
  );
}
