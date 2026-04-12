export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span className="field-group-title">{title}</span>
      {children}
    </div>
  );
}

export function CollapsibleFieldGroup({ title, expanded, onToggle, children }: { title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span
        className="field-group-title"
        style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6 }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 10, transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s", display: "inline-block" }}>
          &#9660;
        </span>
        {title}
      </span>
      {expanded && children}
    </div>
  );
}
