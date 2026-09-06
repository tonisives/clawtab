import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./RepositoryPanel.module.css";

type Worktree = { path: string; branch: string | null; detached: boolean; bare: boolean; locked: boolean; prunable: boolean };
type Repository = { root: string; status: string; staged: string; unstaged: string; truncated: boolean; worktrees: Worktree[] };
let RepositoryContext = createContext<((cwd: string) => void) | null>(null);
export let useRepositoryPanel = () => useContext(RepositoryContext);

export let RepositoryProvider = ({ children, onOpenShell }: { children: ReactNode; onOpenShell: (cwd: string) => Promise<void> }) => {
  let [cwd, setCwd] = useState<string | null>(null);
  let close = useCallback(() => setCwd(null), []);
  return <RepositoryContext.Provider value={setCwd}>{children}{cwd && <RepositoryPanel cwd={cwd} onClose={close} onOpenShell={onOpenShell} />}</RepositoryContext.Provider>;
};

let RepositoryPanel = ({ cwd, onClose, onOpenShell }: { cwd: string; onClose: () => void; onOpenShell: (cwd: string) => Promise<void> }) => {
  let dialog = useRef<HTMLDialogElement>(null);
  let [path, setPath] = useState(cwd);
  let [repository, setRepository] = useState<Repository | null>(null);
  let [tab, setTab] = useState<"unstaged" | "staged" | "status">("unstaged");
  let [loading, setLoading] = useState(true);
  let [error, setError] = useState<string | null>(null);
  let [refresh, setRefresh] = useState(0);
  let [opening, setOpening] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setRepository(null);
    invoke<Repository>("get_git_repository", { cwd: path }).then((result) => { if (active) setRepository(result); })
      .catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, refresh]);
  let handleRefresh = () => setRefresh((value) => value + 1);
  let handlePath = (event: React.ChangeEvent<HTMLSelectElement>) => setPath(event.target.value);
  let handleTab = (event: React.ChangeEvent<HTMLSelectElement>) => setTab(event.target.value as typeof tab);
  let handleOpenShell = async () => {
    if (!repository || opening) return;
    setOpening(true);
    try { await onOpenShell(repository.root); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { setOpening(false); }
  };
  let content = repository?.[tab] ?? "";
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose}>
    <header className={styles.header}><strong>Repository</strong><button type="button" onClick={onClose} aria-label="Close repository">Close</button></header>
    <div className={styles.toolbar}>
      <div className={styles.field}><label htmlFor="repository-worktree">Worktree</label><select id="repository-worktree" value={repository?.root ?? path} onChange={handlePath} disabled={loading || !repository}>
        {repository ? repository.worktrees.map((tree) => <option key={tree.path} value={tree.path} disabled={tree.bare || tree.prunable}>{tree.branch ?? (tree.detached ? "Detached HEAD" : "Bare")} — {tree.path}{tree.locked ? " (locked)" : ""}</option>) : <option value={path}>{path}</option>}
      </select></div>
      <button type="button" onClick={handleRefresh} disabled={loading}>Refresh</button>
      <button type="button" onClick={handleOpenShell} disabled={!repository || opening}>{opening ? "Opening..." : "Open shell"}</button>
      <div className={styles.field}><label htmlFor="repository-changes">Changes</label><select id="repository-changes" value={tab} onChange={handleTab}><option value="unstaged">Unstaged diff</option><option value="staged">Staged diff</option><option value="status">Status (includes untracked files)</option></select></div>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {repository?.truncated && <p className={styles.notice}>Large output was limited to 1 MiB per view.</p>}
    {loading ? <p role="status">Loading repository...</p> : error && !repository ? null : <pre className={styles.diff}>{content ? content.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? styles.added : line.startsWith("-") ? styles.removed : line.startsWith("@@") ? styles.hunk : undefined}>{line}{"\n"}</span>) : "No changes in this view."}</pre>}
  </dialog>;
};
