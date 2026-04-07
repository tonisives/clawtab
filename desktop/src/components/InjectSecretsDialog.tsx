import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SecretEntry {
  key: string;
  source: string;
}

export function InjectSecretsDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (secretKeys: string[]) => void;
  onCancel: () => void;
}) {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<SecretEntry[]>("list_secrets")
      .then(setSecrets)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      ref={overlayRef}
      className="confirm-overlay"
      onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}
    >
      <div className="confirm-dialog" style={{ minWidth: 320, maxWidth: 400 }}>
        <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Inject Secrets
        </div>
        <div style={{ marginBottom: 12, fontSize: 12, color: "var(--text-secondary)" }}>
          Fork session with selected secrets as environment variables.
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {loading && (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
          )}
          {!loading && secrets.length === 0 && (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>
              No secrets available
            </div>
          )}
          {secrets.map((entry) => (
            <label
              key={entry.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                fontSize: 13,
                cursor: "pointer",
                borderRadius: 4,
                color: "var(--text-primary)",
              }}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <input
                type="checkbox"
                checked={selected.has(entry.key)}
                onChange={() => toggle(entry.key)}
              />
              <code style={{ fontSize: 12 }}>{entry.key}</code>
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
                {entry.source}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm([...selected])}
            disabled={selected.size === 0}
          >
            Fork with {selected.size} secret{selected.size !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
