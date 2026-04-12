import type { Job } from "../../../types";

interface SkillsFieldsProps {
  form: Job;
  availableSkills: { name: string }[] | null;
  toggleSkill: (name: string) => void;
}

export function SkillsFields({ form, availableSkills, toggleSkill }: SkillsFieldsProps) {
  return (
    <div className="form-group">
      <label>Skills (included as @references in Claude prompt)</label>
      {availableSkills === null ? (
        <p className="text-secondary">Loading skills...</p>
      ) : availableSkills.length === 0 ? (
        <p className="text-secondary">No skills found. Create them in the Skills tab.</p>
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
          {availableSkills.map((s) => {
            const path = `~/.claude/skills/${s.name}/SKILL.md`;
            return (
              <label key={s.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.skill_paths.includes(path)}
                  onChange={() => toggleSkill(s.name)}
                />
                <span>{s.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  @~/.claude/skills/{s.name}/SKILL.md
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
