import type { CSSProperties } from "react";

interface ErrorPlaceholderProps {
  message: string;
  onClose: () => void;
  headerLeftInset?: number;
}

const wrap: CSSProperties = {
  position: "relative",
  display: "flex",
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
};

const btn: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
};

export function ErrorPlaceholder({ message, onClose, headerLeftInset = 0 }: ErrorPlaceholderProps) {
  const text: CSSProperties = { color: "var(--text-muted)", fontSize: 15, paddingLeft: headerLeftInset };
  return (
    <div style={wrap}>
      <button
        type="button"
        style={btn}
        onClick={onClose}
        title="Close pane"
        aria-label="Close pane"
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--hover-bg, rgba(127,127,127,0.15))"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        {"✕"}
      </button>
      <span style={text}>{message}</span>
    </div>
  );
}
