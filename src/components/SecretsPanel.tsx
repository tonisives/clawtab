import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretEntry } from "../types";
import { ConfirmDialog, DeleteButton } from "./ConfirmDialog";

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
                {isOpen ? "\u25BC" : "\u25B6"}
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

export function SecretsPanel() {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const [gopassAvailable, setGopassAvailable] = useState(false);
  const [gopassEntries, setGopassEntries] = useState<string[]>([]);
  const [gopassSearch, setGopassSearch] = useState("");
  const [showGopassPopup, setShowGopassPopup] = useState(false);
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

  const handleDelete = async (key: string) => {
    try {
      await invoke("delete_secret", { key });
      await loadSecrets();
    } catch (e) {
      console.error("Failed to delete secret:", e);
    }
  };

  const handleOpenGopassPopup = async () => {
    setGopassLoading(true);
    try {
      const entries = await invoke<string[]>("list_gopass_store");
      setGopassEntries(entries);
      setShowGopassPopup(true);
    } catch (e) {
      console.error("Failed to list gopass store:", e);
    } finally {
      setGopassLoading(false);
    }
  };

  const handleImportGopass = async (gopassPath: string) => {
    try {
      const value = await invoke<string>("fetch_gopass_value", { gopassPath });
      setNewValue(value);
      setShowGopassPopup(false);
      setGopassSearch("");
    } catch (e) {
      console.error("Failed to fetch gopass secret:", e);
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
        Secrets are stored in macOS Keychain and injected as environment variables into jobs.
        {gopassAvailable && " You can also import secrets from your gopass store."}
      </p>

      <div className="field-group">
        <span className="field-group-title">Add Secret</span>
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
            <div style={{ display: "flex", gap: 4 }}>
              <input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="secret value"
                style={{ maxWidth: "100%", flex: 1 }}
              />
              {gopassAvailable && (
                <button
                  className="btn btn-sm"
                  onClick={handleOpenGopassPopup}
                  disabled={gopassLoading}
                  title="Import from gopass"
                  style={{ whiteSpace: "nowrap", alignSelf: "center" }}
                >
                  {gopassLoading ? "..." : "gopass"}
                </button>
              )}
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleAdd} style={{ alignSelf: "flex-end", marginBottom: 19 }}>
            Add to Keychain
          </button>
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
              <th>Value</th>
              <th>Actions</th>
              <th style={{ width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={secret.key}>
                <td>
                  <code>{secret.key}</code>
                </td>
                <td>
                  {editingKey === secret.key ? (
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
                    {editingKey === secret.key ? (
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
                  </div>
                </td>
                <td style={{ textAlign: "right", padding: "0 8px" }}>
                  <DeleteButton
                    onClick={() => setConfirmDeleteKey(secret.key)}
                    title="Delete secret"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmDeleteKey && (
        <ConfirmDialog
          message={`Delete secret "${confirmDeleteKey}"? This cannot be undone.`}
          onConfirm={() => { handleDelete(confirmDeleteKey); setConfirmDeleteKey(null); }}
          onCancel={() => setConfirmDeleteKey(null)}
        />
      )}

      {showGopassPopup && (
        <div
          className="confirm-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowGopassPopup(false);
              setGopassSearch("");
              setExpandedFolders(new Set());
            }
          }}
        >
          <div className="confirm-dialog" style={{ width: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <strong style={{ fontSize: 13 }}>Import from gopass</strong>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setShowGopassPopup(false);
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
              autoFocus
            />
            <div style={{ maxHeight: 350, overflowY: "auto" }}>
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
        </div>
      )}
    </div>
  );
}
