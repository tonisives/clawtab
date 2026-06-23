import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import { Platform, type TextInput, type View } from "react-native";

interface UseJobListSearchRefs {
  containerRef: React.RefObject<View | null>;
  searchRef: React.RefObject<TextInput | null>;
}

interface UseJobListSearchState {
  controlledSearchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
}

interface UseJobListSearchParams {
  refs: UseJobListSearchRefs;
  state: UseJobListSearchState;
}

export function useJobListSearch({
  refs,
  state,
}: UseJobListSearchParams) {
  const { containerRef, searchRef } = refs;
  const { controlledSearchQuery, onSearchQueryChange } = state;
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const searchQuery = controlledSearchQuery ?? internalSearchQuery;
  const setSearchQuery = useCallback((next: string) => {
    if (controlledSearchQuery === undefined) setInternalSearchQuery(next);
    onSearchQueryChange?.(next);
  }, [controlledSearchQuery, onSearchQueryChange]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const getContainer = () => (containerRef.current as any) as HTMLElement | undefined;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "/") {
        const element = event.target as HTMLElement;
        const tag = element?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element?.isContentEditable) return;
        const container = getContainer();
        if (!container) return;
        const active = document.activeElement as HTMLElement | null;
        const sidebarFocused = active === document.body || (active && container.contains(active));
        if (!sidebarFocused) return;
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [containerRef, searchRef]);

  return {
    query: searchQuery.toLowerCase().trim(),
    searchQuery,
    setSearchQuery,
  };
}
