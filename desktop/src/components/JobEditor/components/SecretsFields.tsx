import type { Job, SecretEntry } from "../../../types";

interface SecretsFieldsProps {
  form: Job;
  availableSecrets: SecretEntry[] | null;
  secretSearch: string;
  setSecretSearch: (v: string) => void;
  addSecretKey: string;
  setAddSecretKey: (v: string) => void;
  addSecretValue: string;
  setAddSecretValue: (v: string) => void;
  addSecretVisible: boolean;
  setAddSecretVisible: (v: boolean) => void;
  toggleSecret: (key: string) => void;
  handleAddSecretInline: () => Promise<void>;
}

export function SecretsFields({
  form, availableSecrets, secretSearch, setSecretSearch,
  addSecretKey, setAddSecretKey, addSecretValue, setAddSecretValue,
  addSecretVisible, setAddSecretVisible, toggleSecret, handleAddSecretInline,
}: SecretsFieldsProps) {
  const filtered = availableSecrets?.filter((s) =>
    !secretSearch || s.key.toLowerCase().includes(secretSearch.toLowerCase())
  ) ?? [];

  return (
    <div className="form-group">
      <label>Secrets (injected as env vars)</label>
      {availableSecrets === null ? (
        <p className="text-secondary">Loading secrets...</p>
      ) : (
        <>
          {availableSecrets.length > 0 && (
            <input
              type="text"
              value={secretSearch}
              onChange={(e) => setSecretSearch(e.target.value)}
              placeholder="Search secrets..."
              style={{ marginBottom: 6, maxWidth: "100%" }}
            />
          )}
          {filtered.length === 0 && !secretSearch ? (
            <p className="text-secondary">No secrets configured.</p>
          ) : filtered.length === 0 ? (
            <p className="text-secondary">No secrets matching "{secretSearch}".</p>
          ) : (
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
              {filtered.map((s) => (
                <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={form.secret_keys.includes(s.key)}
                    onChange={() => toggleSecret(s.key)}
                  />
                  <span>{s.key}</span>
                </label>
              ))}
            </div>
          )}
          {addSecretVisible ? (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={addSecretKey}
                  onChange={(e) => setAddSecretKey(e.target.value)}
                  placeholder="SECRET_NAME"
                  style={{ flex: 1 }}
                />
                <input
                  type="password"
                  value={addSecretValue}
                  onChange={(e) => setAddSecretValue(e.target.value)}
                  placeholder="secret value"
                  style={{ flex: 2 }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddSecretInline(); }}
                />
                <button className="btn btn-primary btn-sm" onClick={handleAddSecretInline} disabled={!addSecretKey.trim() || !addSecretValue.trim()}>
                  Add
                </button>
                <button className="btn btn-sm" onClick={() => { setAddSecretVisible(false); setAddSecretKey(""); setAddSecretValue(""); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setAddSecretVisible(true)}>
              + Add Secret
            </button>
          )}
        </>
      )}
    </div>
  );
}
