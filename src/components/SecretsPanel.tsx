import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretEntry } from "../types";

interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  isLeaf: boolean;
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const path of paths) {
    const segments = path.split("/");
    let current = root;
    let accumulated = "";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      accumulated = accumulated ? `${accumulated}/${seg}` : seg;
      const isLast = i === segments.length - 1;

      let existing = current.find((n) => n.name === seg && n.isLeaf === isLast);
      if (!existing) {
        existing = { name: seg, fullPath: accumulated, children: [], isLeaf: isLast };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (!n.isLeaf) sortNodes(n.children);
    }
    return nodes;
  };

  return sortNodes(root);
}

function GopassTreeView({
  nodes,
  expanded,
  toggleFolder,
  onImport,
  depth,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  onImport: (path: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.isLeaf) {
          return (
            <div
              key={`leaf-${node.fullPath}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "4px 0",
                paddingLeft: depth * 16,
                borderBottom: "1px solid var(--border)",
              }}
            >
              <code style={{ fontSize: 12 }}>{node.name}</code>
              <button className="btn btn-primary btn-sm" onClick={() => onImport(node.fullPath)}>
                Import
              </button>
            </div>
          );
        }

        const isOpen = expanded.has(node.fullPath);
        return (
          <div key={`folder-${node.fullPath}`}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "4px 0",
                paddingLeft: depth * 16,
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => toggleFolder(node.fullPath)}
            >
              <span style={{ width: 16, fontFamily: "monospace", fontSize: 12, flexShrink: 0 }}>
                {isOpen ? "v" : ">"}
              </span>
              <strong style={{ fontSize: 12 }}>{node.name}/</strong>
            </div>
            {isOpen && (
              <GopassTreeView
                nodes={node.children}
                expanded={expanded}
                toggleFolder={toggleFolder}
                onImport={onImport}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function SourceBadge({ source }: { source: string }) {
  const cls =
    source === "keychain" ? "status-badge status-success" : "status-badge status-running";
  return <span className={cls}>{source}</span>;
}

export function SecretsPanel() {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const [gopassAvailable, setGopassAvailable] = useState(false);
  const [gopassEntries, setGopassEntries] = useState<string[]>([]);
  const [gopassSearch, setGopassSearch] = useState("");
  const [showGopassImport, setShowGopassImport] = useState(false);
  const [gopassLoading, setGopassLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const loadSecrets = async () => {
    try {
      const loaded = await invoke<SecretEntry[]>("list_secrets");
      setSecrets(loaded);
    } catch (e) {
      console.error("Failed to load secrets:", e);
    }
  };

  const checkGopass = async () => {
    try {
      const available = await invoke<boolean>("gopass_available");
      setGopassAvailable(available);
    } catch (e) {
      console.error("Failed to check gopass:", e);
    }
  };

  useEffect(() => {
    loadSecrets();
    checkGopass();
  }, []);

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    try {
      await invoke("set_secret", { key: newKey.trim(), value: newValue.trim() });
      setNewKey("");
      setNewValue("");
      await loadSecrets();
    } catch (e) {
      console.error("Failed to add secret:", e);
    }
  };

  const handleUpdate = async (key: string) => {
    if (!editValue.trim()) return;
    try {
      await invoke("set_secret", { key, value: editValue.trim() });
      setEditingKey(null);
      setEditValue("");
      await loadSecrets();
    } catch (e) {
      console.error("Failed to update secret:", e);
    }
  };

  const handleDelete = async (key: string, source: string) => {
    try {
      if (source === "gopass") {
        await invoke("remove_gopass_secret", { key });
      } else {
        await invoke("delete_secret", { key });
      }
      await loadSecrets();
    } catch (e) {
      console.error("Failed to delete secret:", e);
    }
  };

  const handleLoadGopassEntries = async () => {
    setGopassLoading(true);
    try {
      const entries = await invoke<string[]>("list_gopass_store");
      setGopassEntries(entries);
      setShowGopassImport(true);
    } catch (e) {
      console.error("Failed to list gopass store:", e);
    } finally {
      setGopassLoading(false);
    }
  };

  const handleImportGopass = async (gopassPath: string) => {
    try {
      const key = await invoke<string>("import_gopass_secret", { gopassPath });
      setShowGopassImport(false);
      setGopassSearch("");
      await loadSecrets();
      console.log(`Imported gopass entry as key: ${key}`);
    } catch (e) {
      console.error("Failed to import gopass secret:", e);
    }
  };

  const filteredGopassEntries = gopassSearch
    ? gopassEntries.filter((e) => e.toLowerCase().includes(gopassSearch.toLowerCase()))
    : gopassEntries;

  const gopassTree = useMemo(() => buildTree(filteredGopassEntries), [filteredGopassEntries]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const effectiveExpanded = useMemo(() => {
    if (!gopassSearch) return expandedFolders;
    // Auto-expand all folders when searching
    const all = new Set<string>();
    for (const entry of filteredGopassEntries) {
      const segments = entry.split("/");
      let accumulated = "";
      for (let i = 0; i < segments.length - 1; i++) {
        accumulated = accumulated ? `${accumulated}/${segments[i]}` : segments[i];
        all.add(accumulated);
      }
    }
    return all;
  }, [gopassSearch, expandedFolders, filteredGopassEntries]);

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Secrets</h2>
      </div>
      <p className="section-description">
        Secrets are injected as environment variables into jobs. Keychain secrets are stored in macOS
        Keychain. Gopass secrets stay in your gopass store and are refreshed on each app startup.
      </p>

      {gopassAvailable && (
        <div style={{ marginBottom: 12 }}>
          <button
            className="btn btn-sm"
            onClick={handleLoadGopassEntries}
            disabled={gopassLoading}
          >
            {gopassLoading ? "Loading..." : "Import from gopass"}
          </button>
        </div>
      )}

      {showGopassImport && (
        <div style={{ marginBottom: 20, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>Import from gopass</strong>
            <button
              className="btn btn-sm"
              onClick={() => {
                setShowGopassImport(false);
                setGopassSearch("");
                setExpandedFolders(new Set());
              }}
            >
              Close
            </button>
          </div>
          <input
            type="text"
            value={gopassSearch}
            onChange={(e) => setGopassSearch(e.target.value)}
            placeholder="Filter entries..."
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {filteredGopassEntries.length === 0 ? (
              <p className="text-secondary">No entries found.</p>
            ) : (
              <GopassTreeView
                nodes={gopassTree}
                expanded={effectiveExpanded}
                toggleFolder={toggleFolder}
                onImport={handleImportGopass}
                depth={0}
              />
            )}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 20 }}>
        <div className="form-row" style={{ alignItems: "flex-end" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Key</label>
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="SECRET_NAME"
              style={{ maxWidth: "100%" }}
            />
          </div>
          <div className="form-group" style={{ flex: 2 }}>
            <label>Value</label>
            <input
              type="password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="secret value"
              style={{ maxWidth: "100%" }}
            />
          </div>
          <div className="form-group" style={{ flex: "none" }}>
            <button className="btn btn-primary" onClick={handleAdd}>
              Add to Keychain
            </button>
          </div>
        </div>
      </div>

      {secrets.length === 0 ? (
        <div className="empty-state">
          <p>No secrets stored yet.</p>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Source</th>
              <th>Value</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={`${secret.source}-${secret.key}`}>
                <td>
                  <code>{secret.key}</code>
                </td>
                <td>
                  <SourceBadge source={secret.source} />
                </td>
                <td>
                  {editingKey === secret.key && secret.source === "keychain" ? (
                    <input
                      type="password"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="new value"
                      style={{ maxWidth: "100%" }}
                      autoFocus
                    />
                  ) : (
                    <span style={{ color: "var(--text-secondary)" }}>********</span>
                  )}
                </td>
                <td className="actions">
                  <div className="btn-group">
                    {editingKey === secret.key && secret.source === "keychain" ? (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleUpdate(secret.key)}
                        >
                          Save
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setEditingKey(null);
                            setEditValue("");
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {secret.source === "keychain" && (
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setEditingKey(secret.key);
                              setEditValue("");
                            }}
                          >
                            Update
                          </button>
                        )}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(secret.key, secret.source)}
                        >
                          {secret.source === "gopass" ? "Remove" : "Delete"}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
