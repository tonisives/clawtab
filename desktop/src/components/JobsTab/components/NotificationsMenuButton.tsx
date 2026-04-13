import { useEffect, useRef, useState, type ReactNode } from "react";

interface NotificationsMenuButtonProps {
  activeQuestionCount: number;
  children?: ReactNode;
  hasAutoYesEntries: boolean;
}

export function NotificationsMenuButton({
  activeQuestionCount,
  children,
  hasAutoYesEntries,
}: NotificationsMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const hasContent = !!children || hasAutoYesEntries || activeQuestionCount > 0;

  const updatePopupPosition = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const popupWidth = Math.min(380, window.innerWidth - 20);
    setPopupPosition({
      top: rect.bottom + 6,
      left: Math.min(Math.max(10, rect.right + 6), window.innerWidth - popupWidth - 10),
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePopupPosition();

    const handleMouseDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePopupPosition);
    window.addEventListener("scroll", updatePopupPosition, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePopupPosition);
      window.removeEventListener("scroll", updatePopupPosition, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="notifications-menu" data-tauri-drag-region="false">
      <button
        className={`notifications-menu-btn${open ? " active" : ""}${activeQuestionCount > 0 ? " has-questions" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
        aria-label={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
        aria-expanded={open}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {activeQuestionCount > 0 && (
          <span className="notifications-menu-badge">({activeQuestionCount})</span>
        )}
      </button>

      {open && (
        <div
          className="notifications-menu-popup"
          role="menu"
          style={popupPosition ? { top: popupPosition.top, left: popupPosition.left } : undefined}
        >
          <div className="notifications-menu-title">Notifications</div>
          {hasContent ? (
            <div className="notifications-menu-content">{children}</div>
          ) : (
            <div className="notifications-menu-empty">No pending questions.</div>
          )}
        </div>
      )}
    </div>
  );
}
