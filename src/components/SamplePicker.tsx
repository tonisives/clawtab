import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, Job } from "../types";
import { SAMPLE_TEMPLATES, TEMPLATE_CATEGORIES } from "../data/sampleTemplates";
import type { SampleTemplate, TemplateVariable } from "../data/sampleTemplates";

interface Props {
  autoCreateTemplateId?: string;
  onCreated: () => void;
  onBlank: () => void;
  onCancel: () => void;
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function SamplePicker({ autoCreateTemplateId, onCreated, onBlank, onCancel }: Props) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set());
  const [configuring, setConfiguring] = useState<SampleTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!autoCreateTemplateId) return;
    const template = SAMPLE_TEMPLATES.find((t) => t.id === autoCreateTemplateId);
    if (!template) return;
    if (template.variables && template.variables.length > 0) {
      const defaults: Record<string, string> = {};
      for (const v of template.variables) {
        defaults[v.key] = "";
      }
      setVariableValues(defaults);
      setConfiguring(template);
    } else {
      createJob(template, {});
    }
  }, [autoCreateTemplateId]);

  const toggleCategory = (id: string, rowSiblingId?: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (rowSiblingId) next.delete(rowSiblingId);
        next.add(id);
      }
      return next;
    });
  };

  const toggleTemplate = (id: string) => {
    setExpandedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCreate = (template: SampleTemplate, e: React.MouseEvent) => {
    e.stopPropagation();
    if (template.variables && template.variables.length > 0) {
      const defaults: Record<string, string> = {};
      for (const v of template.variables) {
        defaults[v.key] = "";
      }
      setVariableValues(defaults);
      setConfiguring(template);
    } else {
      createJob(template, {});
    }
  };

  const handleConfigSubmit = () => {
    if (!configuring) return;
    createJob(configuring, variableValues);
  };

  const createJob = async (template: SampleTemplate, vars: Record<string, string>) => {
    setCreating(true);
    setError(null);
    try {
      const settings = await invoke<AppSettings>("get_settings");
      const workDir = settings.default_work_dir || "~";
      const jobName = slugifyName(template.name);

      let templateContent = template.template;
      for (const [key, value] of Object.entries(vars)) {
        const replacement = value || `[${key}]`;
        templateContent = templateContent.split(`[${key}]`).join(replacement);
      }

      if (template.job_type === "folder") {
        const folderPath = workDir.replace(/\/+$/, "") + "/.cwt";
        await invoke("init_cwt_folder", { folderPath, jobName });
        await invoke("write_cwt_entry", { folderPath, jobName, content: templateContent });

        const job: Job = {
          name: template.name,
          job_type: "folder",
          enabled: true,
          path: "",
          args: [],
          cron: template.cron,
          secret_keys: [],
          env: {},
          work_dir: null,
          tmux_session: null,
          aerospace_workspace: null,
          folder_path: folderPath,
          job_name: jobName,
          telegram_chat_id: null,
          telegram_log_mode: "off",
          group: template.group,
          slug: "",
        };
        await invoke("save_job", { job });
      } else {
        const job: Job = {
          name: template.name,
          job_type: template.job_type,
          enabled: true,
          path: "",
          args: [],
          cron: template.cron,
          secret_keys: [],
          env: {},
          work_dir: null,
          tmux_session: null,
          aerospace_workspace: null,
          folder_path: null,
          job_name: null,
          telegram_chat_id: null,
          telegram_log_mode: "off",
          group: template.group,
          slug: "",
        };
        await invoke("save_job", { job });
      }

      setConfiguring(null);
      onCreated();
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setError(msg);
    } finally {
      setCreating(false);
    }
  };

  const templatesByCategory = TEMPLATE_CATEGORIES.map((cat) => ({
    ...cat,
    templates: SAMPLE_TEMPLATES.filter((t) => t.category === cat.id),
  }));

  type CatEntry = (typeof templatesByCategory)[number];
  const rows: CatEntry[][] = [];
  for (let i = 0; i < templatesByCategory.length; i += 2) {
    rows.push(templatesByCategory.slice(i, i + 2));
  }

  const renderCard = (cat: typeof templatesByCategory[number], siblingId?: string) => {
    const isExpanded = expandedCategories.has(cat.id);

    return (
      <div
        key={cat.id}
        className={`sample-card-v2${isExpanded ? " expanded" : ""}`}
      >
        <div className="sample-card-v2-top" onClick={() => toggleCategory(cat.id, siblingId)}>
          <img
            className="sample-card-v2-hero"
            src={cat.image}
            alt={cat.name}
          />
          <div className="sample-card-v2-header">
            <div>
              <h3>{cat.name}</h3>
            </div>
            <span className="sample-card-v2-badge">{cat.templates.length} templates</span>
          </div>
        </div>
        <div className="sample-card-v2-body">
          <div className="sample-card-v2-templates">
            {cat.templates.map((template) => {
              const isTemplateExpanded = expandedTemplates.has(template.id);
              const previewLines = template.template
                .split("\n")
                .filter((l) => l.startsWith("#") || l.startsWith("1.") || l.startsWith("2.") || l.startsWith("3.") || l.startsWith("4."))
                .slice(0, 5)
                .join("\n");

              return (
                <div
                  key={template.id}
                  className={`sample-template-row${isTemplateExpanded ? " expanded" : ""}`}
                  onClick={() => toggleTemplate(template.id)}
                >
                  <div className="sample-template-row-header">
                    <div className="sample-template-row-info">
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </div>
                    <div className="sample-template-row-actions">
                      <code className="sample-template-row-cron">{template.cron || "manual"}</code>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={(e) => handleCreate(template, e)}
                        disabled={creating}
                      >
                        Create
                      </button>
                    </div>
                  </div>
                  <div className="sample-template-row-preview">
                    <pre><code>{previewLines}</code></pre>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>New Job</h2>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
          {error}
        </div>
      )}

      <p className="text-secondary" style={{ marginBottom: 16, fontSize: 13 }}>
        Start from a template or create a blank job.
      </p>

      <div className="sample-grid-cards">
        {rows.map((row, i) => (
          <div key={i} className="sample-grid-row">
            {row.map((cat, j) =>
              renderCard(cat, row[j === 0 ? 1 : 0]?.id)
            )}
          </div>
        ))}
      </div>

      <div className="btn-group" style={{ marginTop: 20 }}>
        <button className="btn" onClick={onBlank}>
          Blank Job
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {configuring && (
        <ConfigModal
          template={configuring}
          variables={configuring.variables ?? []}
          values={variableValues}
          onChange={(key, val) => setVariableValues((prev) => ({ ...prev, [key]: val }))}
          onSubmit={handleConfigSubmit}
          onCancel={() => setConfiguring(null)}
          creating={creating}
        />
      )}
    </div>
  );
}

function ConfigModal({
  template,
  variables,
  values,
  onChange,
  onSubmit,
  onCancel,
  creating,
}: {
  template: SampleTemplate;
  variables: TemplateVariable[];
  values: Record<string, string>;
  onChange: (key: string, val: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  creating: boolean;
}) {
  return (
    <div className="sample-modal-overlay" onClick={onCancel}>
      <div className="sample-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Configure: {template.name}</h3>
        <p className="text-secondary" style={{ fontSize: 12, marginBottom: 16 }}>
          {template.description}
        </p>
        {variables.map((v) => (
          <div key={v.key} className="form-group">
            <label>{v.label}</label>
            <input
              type="text"
              value={values[v.key] ?? ""}
              onChange={(e) => onChange(v.key, e.target.value)}
              placeholder={v.placeholder}
              autoFocus={variables.indexOf(v) === 0}
            />
          </div>
        ))}
        <div className="btn-group" style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={creating}
          >
            {creating ? "Creating..." : "Create"}
          </button>
          <button className="btn" onClick={onCancel} disabled={creating}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
