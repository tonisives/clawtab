import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretEntry } from "../types";

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

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Secrets</h2>
        {gopassAvailable && (
          <button
            className="btn btn-sm"
            onClick={handleLoadGopassEntries}
            disabled={gopassLoading}
          >
            {gopassLoading ? "Loading..." : "Import from gopass"}
          </button>
        )}
      </div>
      <p className="section-description">
        Secrets are injected as environment variables into jobs. Keychain secrets are stored locally;
        gopass secrets are fetched from your gopass store.
      </p>

      {showGopassImport && (
        <div style={{ marginBottom: 20, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>Import from gopass</strong>
            <button
              className="btn btn-sm"
              onClick={() => {
                setShowGopassImport(false);
                setGopassSearch("");
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
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {filteredGopassEntries.length === 0 ? (
              <p className="text-secondary">No entries found.</p>
            ) : (
              filteredGopassEntries.map((entry) => (
                <div
                  key={entry}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "4px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <code style={{ fontSize: 12 }}>{entry}</code>
                  <button className="btn btn-primary btn-sm" onClick={() => handleImportGopass(entry)}>
                    Import
                  </button>
                </div>
              ))
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
