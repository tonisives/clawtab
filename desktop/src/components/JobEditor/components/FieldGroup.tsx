export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span className="field-group-title">{title}</span>
      {children}
    </div>
  );
}

export function CollapsibleFieldGroup({ title, expanded, onToggle, children, badge }: { title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode; badge?: React.ReactNode }) {
  const collapsedTitleStyle: React.CSSProperties = expanded
    ? { cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6 }
    : { cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6, marginBottom: 0, paddingBottom: 0, borderBottom: "none" };
  return (
    <div className="field-group" style={!expanded ? { paddingTop: 12, paddingBottom: 12 } : undefined}>
      <span
        className="field-group-title"
        style={collapsedTitleStyle}
        onClick={onToggle}
      >
        <span style={{ fontSize: 10, transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s", display: "inline-block" }}>
          &#9660;
        </span>
        {title}
        {!expanded && badge}
      </span>
      {expanded && children}
    </div>
  );
}
