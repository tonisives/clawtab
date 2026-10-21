import { useCallback, useEffect, useRef, useState } from "react";

type Entry<T> = {
  session: string;
  index: number;
  key: string;
  value: T;
  url: string;
};

const STATE_KEY = "clawtabSplitNavigation";

/** Keep split-pane navigation in the browser's Back/Forward history. */
export function useWebBackStack<T>({ enabled, navigationKey, value, onRestore }: {
  enabled: boolean;
  navigationKey: string;
  value: T;
  onRestore: (value: T) => void;
}) {
  const latest = useRef({ navigationKey, value, onRestore });
  latest.current = { navigationKey, value, onRestore };
  const current = useRef<Entry<T> | null>(null);
  const restoringKey = useRef<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const restore = (entry: Entry<T>) => {
      current.current = entry;
      restoringKey.current = entry.key;
      setCanGoBack(entry.index > 0);
      latest.current.onRestore(entry.value);
    };
    const saved = window.history.state?.[STATE_KEY] as Entry<T> | undefined;
    if (saved) {
      restore(saved);
    } else {
      const entry: Entry<T> = {
        session: `${Date.now()}-${Math.random()}`,
        index: 0,
        key: latest.current.navigationKey,
        value: latest.current.value,
        url: window.location.href,
      };
      current.current = entry;
      window.history.replaceState({ ...window.history.state, [STATE_KEY]: entry }, "", entry.url);
    }
    const onPopState = (event: PopStateEvent) => {
      const entry = event.state?.[STATE_KEY] as Entry<T> | undefined;
      if (entry && entry.session === current.current?.session) restore(entry);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !current.current) return;
    if (restoringKey.current !== null) {
      if (restoringKey.current !== navigationKey) return;
      restoringKey.current = null;
    }
    const previous = current.current;
    const changed = previous.key !== navigationKey;
    const entry: Entry<T> = {
      session: previous.session,
      index: previous.index + (changed ? 1 : 0),
      key: navigationKey,
      value,
      url: window.location.href,
    };
    if (changed) {
      // Selection updates can replace the URL before React commits this entry.
      window.history.replaceState({ ...window.history.state, [STATE_KEY]: previous }, "", previous.url);
      window.history.pushState({ ...window.history.state, [STATE_KEY]: entry }, "", entry.url);
      setCanGoBack(true);
    } else {
      window.history.replaceState({ ...window.history.state, [STATE_KEY]: entry }, "", entry.url);
    }
    current.current = entry;
  }, [enabled, navigationKey, value]);

  const goBack = useCallback(() => {
    if (current.current && current.current.index > 0) window.history.back();
  }, []);

  return { canGoBack: enabled && canGoBack, goBack };
}
