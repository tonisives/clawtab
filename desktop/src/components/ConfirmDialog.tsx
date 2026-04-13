import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// SF Symbol: xmark.circle (outlined)
const XMarkIcon = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export function DeleteButton({
  onClick,
  title = "Delete",
  size = 13,
  style,
}: {
  onClick: () => void;
  title?: string;
  size?: number;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="btn-delete-icon"
      style={style}
    >
      <XMarkIcon size={size} />
    </button>
  );
}

export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Delete",
  confirmClassName = "btn btn-danger btn-sm",
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  confirmClassName?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (dialog?.open) dialog.close();
    };
  }, [onCancel]);

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
      <div className="confirm-dialog">
        <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button ref={cancelRef} className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button className={confirmClassName} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
