import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "../types";

interface Props {
  tools: ToolInfo[];
  onRefresh: () => Promise<void>;
  showPath?: boolean;
}

interface ToolGroup {
  category: string;
  groupName: string | null;
  required: boolean;
  tools: ToolInfo[];
  satisfied: boolean;
}

function buildGroups(tools: ToolInfo[]): ToolGroup[] {
  const categoryOrder = ["Core", "AI Agent", "Terminal", "Editor", "Optional"];
  const groups: ToolGroup[] = [];
  const seen = new Set<string>();

  for (const cat of categoryOrder) {
    const catTools = tools.filter((t) => t.category === cat);
    if (catTools.length === 0) continue;

    // Collect distinct groups within this category
    const groupNames = new Set(catTools.map((t) => t.group).filter(Boolean));

    // Ungrouped tools first
    const ungrouped = catTools.filter((t) => !t.group);
    for (const tool of ungrouped) {
      const key = `${cat}::${tool.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({
        category: cat,
        groupName: null,
        required: tool.required,
        tools: [tool],
        satisfied: tool.available,
      });
    }

    // Then grouped tools
    for (const gn of groupNames) {
      const key = `${cat}::${gn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const groupTools = catTools.filter((t) => t.group === gn);
      groups.push({
        category: cat,
        groupName: gn!,
        required: groupTools[0]?.required ?? false,
        tools: groupTools,
        satisfied: groupTools.some((t) => t.available),
      });
    }
  }

  return groups;
}

function CategoryHeader({ category }: { category: string }) {
  return (
    <tr>
      <td
        colSpan={4}
        style={{
          paddingTop: 16,
          paddingBottom: 6,
          fontWeight: 600,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          color: "var(--text-secondary)",
          borderBottom: "none",
        }}
      >
        {category}
      </td>
    </tr>
  );
}

function GroupSatisfaction({ group }: { group: ToolGroup }) {
  if (group.satisfied && !group.required) {
    return <span className="status-dot running" />;
  }
  if (group.satisfied) {
    return <span className="status-badge status-success">ok</span>;
  }
  if (!group.required) {
    return <span className="status-badge status-idle">optional</span>;
  }
  return <span className="status-badge status-failed">missing</span>;
}

function InstallButton({
  tool,
  onRefresh,
}: {
  tool: ToolInfo;
  onRefresh: () => Promise<void>;
}) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (tool.available || !tool.brew_formula) return null;

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      await invoke<string>("install_tool", { formula: tool.brew_formula });
      await onRefresh();
    } catch (e) {
      setError(String(e));
    }
    setInstalling(false);
  };

  return (
    <span>
      <button
        className="btn btn-sm"
        onClick={handleInstall}
        disabled={installing}
        style={{ marginLeft: 8 }}
      >
        {installing ? "Installing..." : "Install"}
      </button>
      {error && (
        <span
          style={{ color: "var(--danger-color)", fontSize: 11, marginLeft: 6 }}
          title={error}
        >
          failed
        </span>
      )}
    </span>
  );
}

export function ToolGroupList({ tools, onRefresh, showPath = false }: Props) {
  const groups = buildGroups(tools);

  // Track which categories we've already rendered a header for
  let lastCategory = "";

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Tool</th>
          <th>Version</th>
          {showPath && <th>Path</th>}
          <th style={{ width: 1 }}></th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const rows: React.ReactNode[] = [];
          const needsHeader = group.category !== lastCategory;
          if (needsHeader) {
            lastCategory = group.category;
            rows.push(
              <CategoryHeader key={`cat-${group.category}`} category={group.category} />
            );
          }

          // If this is a named group, show group header row
          if (group.groupName && group.tools.length > 1) {
            rows.push(
              <tr key={`grp-${group.groupName}`}>
                <td>
                  <GroupSatisfaction group={group} />
                </td>
                <td
                  colSpan={showPath ? 3 : 2}
                  style={{ fontStyle: "italic", color: "var(--text-secondary)", fontSize: 12 }}
                >
                  {group.required ? "at least one required" : "optional"}
                </td>
                <td></td>
              </tr>
            );
          }

          for (const tool of group.tools) {
            const indent = group.groupName && group.tools.length > 1;
            rows.push(
              <tr key={tool.name}>
                <td>
                  {/* For single-tool groups or ungrouped, show status directly */}
                  {!(group.groupName && group.tools.length > 1) ? (
                    <GroupSatisfaction
                      group={{ ...group, satisfied: tool.available, tools: [tool] }}
                    />
                  ) : (
                    <span
                      className={`status-dot ${tool.available ? "running" : "error"}`}
                    />
                  )}
                </td>
                <td style={indent ? { paddingLeft: 24 } : undefined}>{tool.name}</td>
                <td>
                  {tool.version ? (
                    <code>{tool.version}</code>
                  ) : (
                    <span className="text-secondary">--</span>
                  )}
                </td>
                {showPath && (
                  <td>
                    {tool.path ? (
                      <code>{tool.path}</code>
                    ) : (
                      <span className="text-secondary">not found</span>
                    )}
                  </td>
                )}
                <td>
                  <InstallButton tool={tool} onRefresh={onRefresh} />
                </td>
              </tr>
            );
          }

          return rows;
        })}
      </tbody>
    </table>
  );
}
