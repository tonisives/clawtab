import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog, DeleteButton } from "./ConfirmDialog";

interface SkillEntry {
  name: string;
  content: string;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const entries = await invoke<SkillEntry[]>("list_skills");
      setSkills(entries);
    } catch (e) {
      console.error("Failed to list skills:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const startEdit = (skill: SkillEntry) => {
    setEditingSkill(skill.name);
    setEditContent(skill.content);
  };

  const cancelEdit = () => {
    setEditingSkill(null);
    setEditContent("");
  };

  const saveEdit = async () => {
    if (!editingSkill) return;
    setSaving(true);
    try {
      await invoke("write_skill", { name: editingSkill, content: editContent });
      await loadSkills();
      setEditingSkill(null);
      setEditContent("");
    } catch (e) {
      console.error("Failed to save skill:", e);
    }
    setSaving(false);
  };

  const createSkill = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await invoke("write_skill", {
        name,
        content: "# " + name + "\n\nDescribe this skill here.\n",
      });
      await loadSkills();
      setCreating(false);
      setNewName("");
      // Open the new skill for editing
      const created = (await invoke<SkillEntry[]>("list_skills")).find(
        (s) => s.name === name
      );
      if (created) startEdit(created);
    } catch (e) {
      console.error("Failed to create skill:", e);
    }
    setSaving(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await invoke("delete_skill", { name: deleteTarget });
      if (editingSkill === deleteTarget) cancelEdit();
      await loadSkills();
    } catch (e) {
      console.error("Failed to delete skill:", e);
    }
    setDeleteTarget(null);
  };

  const openInEditor = async (name: string) => {
    try {
      await invoke("open_skill_in_editor", { name });
    } catch (e) {
      console.error("Failed to open in editor:", e);
    }
  };

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Skills</h2>
        <button
          className="btn btn-sm"
          onClick={() => {
            setCreating(true);
            setNewName("");
          }}
        >
          New Skill
        </button>
      </div>

      <p className="section-description">
        Skills are reusable instructions stored in{" "}
        <code>~/.claude/skills/</code>. Reference them in jobs with{" "}
        <code>{"@~/.claude/skills/<name>/SKILL.md"}</code>
      </p>

      {creating && (
        <div className="field-group" style={{ marginBottom: 16 }}>
          <span className="field-group-title">New Skill</span>
          <div className="form-group">
            <label>Skill Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="my-skill"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") createSkill();
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <span className="hint">
              Creates ~/.claude/skills/{newName || "<name>"}/SKILL.md
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={createSkill}
              disabled={!newName.trim() || saving}
            >
              Create
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && skills.length === 0 ? (
        <div className="empty-state">
          <p>Loading skills...</p>
        </div>
      ) : skills.length === 0 && !creating ? (
        <div className="empty-state">
          <p>No skills found. Create one to get started.</p>
        </div>
      ) : (
        <div className="skills-list">
          {skills.map((skill) => (
            <div key={skill.name} className="field-group skill-row">
              <div className="skill-row-header">
                <div className="skill-row-info">
                  <strong>{skill.name}</strong>
                  <span className="skill-row-path">
                    ~/.claude/skills/{skill.name}/SKILL.md
                  </span>
                </div>
                <div className="skill-row-actions">
                  {editingSkill !== skill.name && (
                    <>
                      <button
                        className="btn btn-sm"
                        onClick={() => startEdit(skill)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => openInEditor(skill.name)}
                        title="Open in external editor"
                      >
                        Open
                      </button>
                    </>
                  )}
                  <DeleteButton
                    onClick={() => setDeleteTarget(skill.name)}
                    title={`Delete skill "${skill.name}"`}
                  />
                </div>
              </div>

              {editingSkill === skill.name ? (
                <div className="skill-editor">
                  <textarea
                    className="directions-editor"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    style={{ height: 300, maxWidth: "100%" }}
                  />
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    <button
                      className="btn btn-sm"
                      onClick={saveEdit}
                      disabled={saving}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button className="btn btn-sm" onClick={cancelEdit}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => openInEditor(skill.name)}
                      style={{ marginLeft: "auto" }}
                    >
                      Open in Editor
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="skill-preview">{skill.content}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete skill "${deleteTarget}"? This will remove the entire skill directory.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
