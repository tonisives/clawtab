import { SAMPLE_TEMPLATES, TEMPLATE_CATEGORIES } from "../../../data/sampleTemplates";

interface TemplateGridProps {
  expandedCategory: string | null;
  setExpandedCategory: (v: string | null) => void;
  onPickTemplate: (templateId: string) => void;
}

export function TemplateGrid({ expandedCategory, setExpandedCategory, onPickTemplate }: TemplateGridProps) {
  const templatesByCategory = TEMPLATE_CATEGORIES.map((cat) => ({
    ...cat,
    templates: SAMPLE_TEMPLATES.filter((t) => t.category === cat.id),
  }));
  const templateRows: (typeof templatesByCategory)[] = [];
  for (let i = 0; i < templatesByCategory.length; i += 2) {
    templateRows.push(templatesByCategory.slice(i, i + 2));
  }

  return (
    <div>
      <p className="text-secondary" style={{ marginTop: 32, marginBottom: 16, fontSize: 13, textAlign: "center" }}>
        Or start from a template:
      </p>
      <div className="sample-grid-cards">
        {templateRows.map((row, i) => (
          <div key={i} className="sample-grid-row">
            {row.map((cat) => (
              <div
                key={cat.id}
                className={`sample-card-v2${expandedCategory === cat.id ? " expanded" : ""}`}
              >
                <div className="sample-card-v2-top" onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}>
                  <img className="sample-card-v2-hero" src={cat.image} alt={cat.name} />
                  <div className="sample-card-v2-header">
                    <div><h3>{cat.name}</h3></div>
                    <span className="sample-card-v2-badge">{cat.templates.length} templates</span>
                  </div>
                </div>
                <div className="sample-card-v2-body">
                  <div className="sample-card-v2-templates">
                    {cat.templates.map((template) => (
                      <div key={template.id} className="sample-template-row">
                        <div className="sample-template-row-header">
                          <div className="sample-template-row-info">
                            <strong>{template.name}</strong>
                            <span>{template.description}</span>
                          </div>
                          <div className="sample-template-row-actions">
                            <code className="sample-template-row-cron">{template.cron || "manual"}</code>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={(e) => { e.stopPropagation(); onPickTemplate(template.id); }}
                            >
                              Create
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
