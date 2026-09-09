import { useEffect, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import styles from "./AboutPanel.module.css";

const ABOUT_LINKS = [
  { label: "Website", url: "https://clawtab.cc" },
  { label: "Documentation", url: "https://clawtab.cc/docs" },
  { label: "Articles", url: "https://clawtab.cc/articles" },
  { label: "Privacy policy", url: "https://clawtab.cc/privacy" },
];

export let AboutPanel = () => {
  let [version, setVersion] = useState("Loading...");
  let [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_version")
      .then((value) => { if (!cancelled) setVersion(value); })
      .catch(() => { if (!cancelled) setVersion("Unavailable"); });
    return () => { cancelled = true; };
  }, []);

  let openExternalLink = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    let url = event.currentTarget.href;
    setLinkError(null);
    try {
      await openUrl(url);
    } catch {
      setLinkError("Could not open the link. Please try again.");
    }
  };

  return (
    <section className={styles.about}>
      <h1 className={styles.title}>ClawTab</h1>
      <p className={styles.description}>Manage your AI agents, automate tasks, and stay connected from your desktop.</p>
      <dl className={styles.details}>
        <dt>Version</dt>
        <dd>{version}</dd>
        <dt>App</dt>
        <dd>ClawTab Desktop</dd>
      </dl>
      <nav className={styles.links} aria-label="ClawTab information">
        {ABOUT_LINKS.map(({ label, url }) => (
          <a key={url} href={url} onClick={openExternalLink} title={`${label} (opens in browser)`} aria-label={`${label} (opens in browser)`}>
            <span>{label}</span>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 3h6v6M10 14L21 3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </a>
        ))}
      </nav>
      {linkError && <p role="alert" className={styles.error}>{linkError}</p>}
    </section>
  );
};
