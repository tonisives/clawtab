import { useEffect, useRef, useState } from "react";

export function EditTextDialog({
  title,
  label,
  initialValue,
  placeholder,
  saveLabel = "Save",
  onSave,
  onCancel,
}: {
  title: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  saveLabel?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialValue]);

  useEffect(() => {
    inputRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onSave(value);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel, onSave, value]);

  return (
    <div
      ref={overlayRef}
      className="confirm-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
    >
      <div className="confirm-dialog" style={{ width: 420, maxWidth: "calc(100vw - 32px)" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>{title}</h3>
        <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
          {label}
        </label>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-tertiary)",
            color: "var(--text-primary)",
            fontSize: 13,
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => onSave(value)}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
