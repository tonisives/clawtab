import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ToolInfo } from "../types";

interface Props {
  tools: ToolInfo[];
  onRefresh: () => Promise<void>;
  showPath?: boolean;
  selections?: Record<string, string>;
  onSelect?: (group: string, toolName: string) => void;
}

interface ToolGroup {
  category: string;
  groupName: string | null;
  required: boolean;
  tools: ToolInfo[];
  satisfied: boolean;
}

function buildGroups(tools: ToolInfo[]): ToolGroup[] {
  const categoryOrder = ["AI Agent", "Required", "Terminal", "Editor", "Optional", "Browser"];
  const groups: ToolGroup[] = [];
  const seen = new Set<string>();

  for (const cat of categoryOrder) {
    const catTools = tools.filter((t) => t.category === cat);
    if (catTools.length === 0) continue;

    const groupNames = new Set(catTools.map((t) => t.group).filter(Boolean));

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

    for (const gn of groupNames) {
      const key = `${cat}::${gn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const groupTools = catTools.filter((t) => t.group === gn);
      const hideUnavailable = cat === "Terminal" || cat === "Editor";
      const visibleTools = hideUnavailable ? groupTools.filter((t) => t.available) : groupTools;
      if (visibleTools.length === 0) continue;
      groups.push({
        category: cat,
        groupName: gn!,
        required: visibleTools[0]?.required ?? false,
        tools: visibleTools,
        satisfied: visibleTools.some((t) => t.available),
      });
    }
  }

  return groups;
}

function groupByCategory(groups: ToolGroup[]): Map<string, ToolGroup[]> {
  const map = new Map<string, ToolGroup[]>();
  for (const g of groups) {
    const list = map.get(g.category) ?? [];
    list.push(g);
    map.set(g.category, list);
  }
  return map;
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
    <>
      <button
        className="btn btn-sm"
        onClick={handleInstall}
        disabled={installing}
        style={{ padding: "1px 6px", fontSize: 11 }}
      >
        {installing ? "..." : "install"}
      </button>
      {error && (
        <span
          style={{ color: "var(--danger-color)", fontSize: 11, marginLeft: 4 }}
          title={error}
        >
          failed
        </span>
      )}
    </>
  );
}

function LocateButton({
  tool,
  onRefresh,
}: {
  tool: ToolInfo;
  onRefresh: () => Promise<void>;
}) {
  const handleLocate = async () => {
    const selected = await open({
      title: `Locate ${tool.name}`,
      multiple: false,
      directory: false,
    });
    if (selected) {
      await invoke("set_tool_path", { toolName: tool.name, path: selected });
      await onRefresh();
    }
  };

  return (
    <button
      className="btn btn-sm"
      onClick={handleLocate}
      style={{ padding: "1px 6px", fontSize: 11 }}
    >
      locate
    </button>
  );
}

function ToolActions({
  tool,
  onRefresh,
}: {
  tool: ToolInfo;
  onRefresh: () => Promise<void>;
}) {
  if (tool.available) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <InstallButton tool={tool} onRefresh={onRefresh} />
      <LocateButton tool={tool} onRefresh={onRefresh} />
    </span>
  );
}

function SelectableGroupRows({
  group,
  showPath,
  onRefresh,
  selectedTool,
  onSelect,
}: {
  group: ToolGroup;
  showPath: boolean;
  onRefresh: () => Promise<void>;
  selectedTool: string | undefined;
  onSelect: ((group: string, toolName: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSelectable = !!onSelect && !!group.groupName;
  const selected = selectedTool || group.tools.find((t) => t.available)?.name;

  const selectedToolInfo = group.tools.find((t) => t.name === selected);
  const otherTools = group.tools.filter((t) => t.name !== selected);
  const hasOthers = otherTools.length > 0;

  if (!isSelectable || group.tools.length <= 1) {
    return (
      <>
        {group.tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            showPath={showPath}
            onRefresh={onRefresh}
            indent={false}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {selectedToolInfo && (
        <tr key={selectedToolInfo.name}>
          <td>
            <span className={`status-dot ${selectedToolInfo.available ? "running" : "error"}`} />
          </td>
          <td>{selectedToolInfo.name}</td>
          <td>
            {selectedToolInfo.version ? (
              <code>{selectedToolInfo.version}</code>
            ) : (
              <span className="text-secondary">--</span>
            )}
          </td>
          {showPath && (
            <td>
              {selectedToolInfo.path ? (
                <code>{selectedToolInfo.path}</code>
              ) : (
                <span className="text-secondary">not found</span>
              )}
            </td>
          )}
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <span className="status-badge status-success" style={{ fontSize: 11 }}>selected</span>
            {!selectedToolInfo.available && (
              <LocateButton tool={selectedToolInfo} onRefresh={onRefresh} />
            )}
            {hasOthers && (
              <button
                className="btn btn-sm"
                onClick={() => setExpanded(!expanded)}
                style={{ marginLeft: 4, padding: "1px 6px", fontSize: 11 }}
              >
                {expanded ? "hide" : `+${otherTools.length} more`}
              </button>
            )}
          </td>
        </tr>
      )}
      {expanded && otherTools.map((tool) => (
        <tr key={tool.name} style={{ opacity: tool.available ? 1 : 0.5 }}>
          <td>
            <span className={`status-dot ${tool.available ? "running" : "error"}`} />
          </td>
          <td style={{ paddingLeft: 12 }}>{tool.name}</td>
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
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            {tool.available && isSelectable ? (
              <button
                className="btn btn-sm"
                onClick={() => {
                  onSelect!(group.groupName!, tool.name);
                  setExpanded(false);
                }}
                style={{ padding: "1px 6px", fontSize: 11 }}
              >
                select
              </button>
            ) : (
              <span style={{ display: "inline-flex", gap: 4 }}>
                <InstallButton tool={tool} onRefresh={onRefresh} />
                {!tool.available && <LocateButton tool={tool} onRefresh={onRefresh} />}
              </span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

function ToolRow({
  tool,
  showPath,
  onRefresh,
  indent,
}: {
  tool: ToolInfo;
  showPath: boolean;
  onRefresh: () => Promise<void>;
  indent: boolean;
}) {
  return (
    <tr>
      <td>
        {tool.available ? (
          <span className="status-dot running" />
        ) : tool.required ? (
          <span className="status-badge status-failed">missing</span>
        ) : (
          <span className="status-badge status-idle">optional</span>
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
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <ToolActions tool={tool} onRefresh={onRefresh} />
      </td>
    </tr>
  );
}

export function ToolGroupList({ tools, onRefresh, showPath = false, selections, onSelect }: Props) {
  const groups = buildGroups(tools);
  const byCategory = groupByCategory(groups);
  const categoryOrder = ["AI Agent", "Required", "Terminal", "Editor", "Optional", "Browser"];

  return (
    <div>
      {categoryOrder.map((cat) => {
        const catGroups = byCategory.get(cat);
        if (!catGroups || catGroups.length === 0) return null;

        return (
          <div className="field-group" key={cat}>
            <span className="field-group-title">{cat}</span>
            <table className="data-table tools-table">
              <thead>
                <tr>
                  <th className="col-tool-status"></th>
                  <th className="col-tool-name">Tool</th>
                  <th className="col-tool-version">Version</th>
                  {showPath && <th className="col-tool-path">Path</th>}
                  <th className="col-tool-actions"></th>
                </tr>
              </thead>
              <tbody>
                {catGroups.map((group) => {
                  const selectedTool = group.groupName ? selections?.[group.groupName] : undefined;
                  return (
                    <SelectableGroupRows
                      key={`grp-${group.groupName ?? group.tools[0]?.name}`}
                      group={group}
                      showPath={showPath}
                      onRefresh={onRefresh}
                      selectedTool={selectedTool}
                      onSelect={onSelect}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
