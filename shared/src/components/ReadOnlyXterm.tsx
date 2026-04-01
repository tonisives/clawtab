import { useRef, useEffect, useCallback } from "react";
import { View } from "react-native";
import { XtermLog } from "./XtermLog";
import type { XtermLogHandle } from "./XtermLog";
import { collapseSeparators } from "../util/logs";

interface ReadOnlyXtermProps {
  content: string;
  borderless?: boolean;
  onColumnsChange?: (cols: number) => void;
}

export function ReadOnlyXterm({ content, onColumnsChange }: ReadOnlyXtermProps) {
  const termRef = useRef<XtermLogHandle | null>(null);
  const prevContentRef = useRef("");
  const readyRef = useRef(false);

  const processed = collapseSeparators(content);

  const handleResize = useCallback(
    (cols: number, _rows: number) => {
      onColumnsChange?.(cols);
    },
    [onColumnsChange],
  );

  // Write initial content once terminal is ready (small delay for mount)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (termRef.current && !readyRef.current) {
        readyRef.current = true;
        if (processed) {
          termRef.current.writeText(processed);
          prevContentRef.current = processed;
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Incremental update when content changes
  useEffect(() => {
    if (!readyRef.current || !termRef.current) return;
    const prev = prevContentRef.current;
    if (processed === prev) return;

    if (processed.startsWith(prev) && prev.length > 0) {
      // Append-only: write the new portion
      termRef.current.writeText(processed.slice(prev.length));
    } else {
      // Full replacement
      termRef.current.clear();
      if (processed) {
        // Small delay to let reset complete
        requestAnimationFrame(() => {
          termRef.current?.writeText(processed);
        });
      }
    }
    prevContentRef.current = processed;
  }, [processed]);

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: "hidden" as any }}>
      <XtermLog ref={termRef} interactive={false} onResize={handleResize} />
    </View>
  );
}
