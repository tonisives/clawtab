import { useEffect, useRef } from "react";
import type * as React from "react";
import { Platform, type ScrollView } from "react-native";

import type { RemoteJob } from "../../types/job";
import type { DetectedProcess, ShellPane } from "../../types/process";
import { colors } from "../../theme/colors";

interface UseScrollEffectsParams {
  collapsedGroups: Set<string>;
  detectedProcesses: DetectedProcess[];
  groupTabView?: Record<string, "tabs" | "jobs">;
  initialScrollOffset?: number;
  jobs: RemoteJob[];
  onGroupTabViewChange?: (group: string, view: "tabs" | "jobs") => void;
  onToggleGroup: (group: string) => void;
  scrollRef: React.RefObject<ScrollView | null>;
  scrollToSlug?: { slug: string; seq: number } | null;
  shellPanes: ShellPane[];
}

export function useScrollEffects({
  collapsedGroups,
  detectedProcesses,
  groupTabView,
  initialScrollOffset,
  jobs,
  onGroupTabViewChange,
  onToggleGroup,
  scrollRef,
  scrollToSlug,
  shellPanes,
}: UseScrollEffectsParams) {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const styleId = "clawtab-reveal-highlight-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes clawtab-reveal-highlight {
        0%   { box-shadow: 0 0 0 2px ${colors.accent}; background: color-mix(in srgb, ${colors.accent} 18%, transparent); }
        70%  { box-shadow: 0 0 0 2px ${colors.accent}; background: color-mix(in srgb, ${colors.accent} 8%, transparent); }
        100% { box-shadow: none; background: transparent; }
      }
      .clawtab-reveal-highlight {
        animation: clawtab-reveal-highlight 0.9s ease-out forwards;
        border-radius: 8px;
      }
    `;
    document.head.appendChild(style);
  }, []);

  const pendingScrollSlug = useRef<string | null>(null);
  const handledScrollSeq = useRef<number | null>(null);

  useEffect(() => {
    if (!scrollToSlug || Platform.OS !== "web") return;
    if (handledScrollSeq.current === scrollToSlug.seq) return;
    handledScrollSeq.current = scrollToSlug.seq;
    const slug = scrollToSlug.slug;
    pendingScrollSlug.current = slug;

    const job = jobs.find((item) => item.slug === slug);
    if (job) {
      const groupKey = job.group || "default";
      const folderPath = jobs.filter((item) => (item.group || "default") === groupKey)[0]?.folder_path;
      const displayGroup = groupKey === "default"
        ? (folderPath ? folderPath.split("/").filter(Boolean).pop() ?? "General" : "General")
        : groupKey;
      if (collapsedGroups.has(displayGroup)) {
        onToggleGroup(displayGroup);
        return;
      }
      if ((groupTabView?.[groupKey] ?? "tabs") !== "jobs") {
        onGroupTabViewChange?.(groupKey, "jobs");
        return;
      }
    }

    const process = detectedProcesses.find((item) => item.pane_id === slug);
    if (process) {
      const folder = process.cwd;
      const folderName = folder.split("/").filter(Boolean).pop() ?? folder;
      const detectedKey = `_det_${folder}`;
      if (collapsedGroups.has(detectedKey) || collapsedGroups.has(folderName)) {
        onToggleGroup(collapsedGroups.has(detectedKey) ? detectedKey : folderName);
        return;
      }
    }

    const shell = shellPanes.find((item) => item.pane_id === slug);
    if (shell && collapsedGroups.has("Shells")) {
      onToggleGroup("Shells");
    }
  }, [scrollToSlug, jobs, collapsedGroups, onToggleGroup, detectedProcesses, shellPanes, groupTabView, onGroupTabViewChange]);

  useEffect(() => {
    if (!pendingScrollSlug.current || Platform.OS !== "web") return;
    const slug = pendingScrollSlug.current;
    const escaped = CSS.escape(slug);
    const findElement = () => (
      document.querySelector(`[data-job-slug="${escaped}"]`) ??
      document.querySelector(`[data-process-id="${escaped}"]`) ??
      document.querySelector(`[data-shell-id="${escaped}"]`)
    ) as HTMLElement | null;

    const scrollAndHighlight = (element: HTMLElement) => {
      pendingScrollSlug.current = null;
      element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      element.classList.remove("clawtab-reveal-highlight");
      void element.offsetWidth;
      element.classList.add("clawtab-reveal-highlight");
      element.addEventListener("animationend", () => element.classList.remove("clawtab-reveal-highlight"), { once: true });
    };

    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled) return;
      const element = findElement();
      if (element) {
        scrollAndHighlight(element);
      } else {
        requestAnimationFrame(() => {
          if (cancelled) return;
          const nextElement = findElement();
          if (nextElement) scrollAndHighlight(nextElement);
        });
      }
    });
    return () => { cancelled = true; };
  }, [scrollToSlug, collapsedGroups]);

  useEffect(() => {
    if (!initialScrollOffset) return;
    const restore = () => scrollRef.current?.scrollTo({ y: initialScrollOffset, animated: false });
    requestAnimationFrame(() => requestAnimationFrame(restore));
    const timeout = setTimeout(restore, 100);
    return () => clearTimeout(timeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = (scrollRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (node.scrollTop <= 0) {
          node.scrollTop = 1;
        } else if (node.scrollTop + node.clientHeight >= node.scrollHeight) {
          node.scrollTop = node.scrollHeight - node.clientHeight - 1;
        }
      }, 150);
    };
    requestAnimationFrame(() => { if (node.scrollTop === 0 && node.scrollHeight > node.clientHeight) node.scrollTop = 1; });
    node.addEventListener("scroll", nudge, { passive: true });
    return () => { node.removeEventListener("scroll", nudge); if (timer) clearTimeout(timer); };
  }, [scrollRef]);
}
