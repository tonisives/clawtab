import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SkillEntry {
  name: string;
  content: string;
}

export function SkillSearchDialog({
  onSelect,
  onCancel,
}: {
  onSelect: (skillName: string) => void;
  onCancel: () => void;
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<SkillEntry[]>("list_skills")
      .then(setSkills)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const filtered = query.trim()
    ? skills.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
    : skills;

  return (
    <div
      ref={overlayRef}
      className="confirm-overlay"
      onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}
    >
      <div className="confirm-dialog" style={{ minWidth: 320, maxWidth: 400 }}>
        <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Send Skill
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills..."
          className="input input-sm"
          style={{ width: "100%", marginBottom: 8, fontSize: 13 }}
        />
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          {loading && (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>
              {query.trim() ? `No skills matching "${query}"` : "No skills found"}
            </div>
          )}
          {filtered.map((skill) => (
            <button
              key={skill.name}
              className="btn-ghost"
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                fontSize: 13,
                cursor: "pointer",
                borderRadius: 4,
                border: "none",
                background: "none",
                color: "var(--text-primary)",
              }}
              onClick={() => onSelect(skill.name)}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              /{skill.name}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
