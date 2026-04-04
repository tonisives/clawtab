import { useRef, useEffect, useCallback, useMemo } from "react";
import { View, Platform } from "react-native";
import { XtermLog } from "./XtermLog";
import type { XtermLogHandle } from "./XtermLog";
import { collapseSeparators } from "../util/logs";

const isWeb = Platform.OS === "web";

interface ReadOnlyXtermProps {
  content: string;
  borderless?: boolean;
  onColumnsChange?: (cols: number) => void;
}

export function ReadOnlyXterm({ content, onColumnsChange }: ReadOnlyXtermProps) {
  const termRef = useRef<XtermLogHandle | null>(null);
  const prevContentRef = useRef("");
  const readyRef = useRef(false);
  // Buffer content until terminal is ready
  const pendingRef = useRef<string | null>(null);

  const processed = useMemo(() => collapseSeparators(content), [content]);

  const flush = useCallback(() => {
    if (!termRef.current) return;
    const text = pendingRef.current;
    if (text === null) return;
    pendingRef.current = null;
    termRef.current.writeText(text);
    prevContentRef.current = text;
  }, []);

  // xterm.js fires onResize once it's initialised - use that as the ready signal
  const handleResize = useCallback(
    (cols: number, _rows: number) => {
      onColumnsChange?.(cols);
      if (!readyRef.current) {
        readyRef.current = true;
        flush();
      }
    },
    [onColumnsChange, flush],
  );

  // Queue or write content changes
  useEffect(() => {
    if (!readyRef.current) {
      // Terminal not ready yet - buffer
      pendingRef.current = processed;
      return;
    }
    if (!termRef.current) return;
    const prev = prevContentRef.current;
    if (processed === prev) return;

    if (processed.startsWith(prev) && prev.length > 0) {
      termRef.current.writeText(processed.slice(prev.length));
    } else {
      termRef.current.clear();
      requestAnimationFrame(() => {
        termRef.current?.writeText(processed);
      });
    }
    prevContentRef.current = processed;
  }, [processed]);

  const inner = <XtermLog ref={termRef} interactive={false} onResize={handleResize} />;

  if (isWeb) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
        {inner}
      </div>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {inner}
    </View>
  );
}
