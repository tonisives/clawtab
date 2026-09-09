import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import { useMachines } from "../machines/client";

type PreferencesApi = (method: string, path: string, body?: Record<string, unknown>) => Promise<Record<string, any>>;

export let useHiddenGroups = (api: PreferencesApi) => {
  let { connected, connectionId } = useMachines();
  let [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() => new Set());
  let revision = useRef(0);
  let generation = useRef(0);
  let queue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    generation.current += 1;
    if (!connected) {
      setHiddenGroups(new Set());
      return;
    }
    let refresh = async () => {
      let version = revision.current;
      await queue.current;
      try {
        let result = await api("GET", "/account/preferences");
        if (active && version === revision.current) setHiddenGroups(new Set(result.hidden_groups ?? []));
      } catch { /* Keep the last confirmed preferences until the next refresh. */ }
    };
    void refresh();
    let interval = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(interval); };
  }, [api, connected, connectionId]);

  let setHidden = useCallback((group: string, hidden: boolean) => {
    let version = ++revision.current;
    let session = generation.current;
    // Wait for database confirmation; failed saves must not look successful.
    queue.current = queue.current.then(async () => {
      if (session !== generation.current) return;
      try {
        let result = await api("POST", "/account/preferences", { group, hidden });
        if (session === generation.current && version === revision.current) {
          setHiddenGroups(new Set(result.hidden_groups ?? []));
        }
      } catch (error) {
        if (session !== generation.current) return;
        let message = error instanceof Error ? error.message : "Could not save hidden groups";
        if (Platform.OS === "web") globalThis.alert(`Could not save group preference: ${message}`);
        else Alert.alert("Could not save group preference", message);
      }
    });
  }, [api]);
  let hideGroup = useCallback((group: string) => setHidden(group, true), [setHidden]);
  let unhideGroup = useCallback((group: string) => setHidden(group, false), [setHidden]);
  return { hiddenGroups, hideGroup, unhideGroup };
};
