import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(initialValue);
  const [value, setValue] = useState(initialValue);
  valueRef.current = value;

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (initialValue.trim()) {
        input.select();
      }
    }, 0);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onSave(valueRef.current);
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKey);
      if (dialog?.open) dialog.close();
    };
  }, [initialValue, onCancel, onSave]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="confirm-overlay"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel();
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
          onFocus={(e) => {
            if (initialValue.trim() && e.currentTarget.value === initialValue) {
              e.currentTarget.select();
            }
          }}
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
    </dialog>,
    document.body,
  );
}
