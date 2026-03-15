import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport";

export function useLogBuffer(transport: Transport, jobName: string) {
  const [logs, setLogs] = useState("");
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    unsubRef.current = transport.subscribeLogs(jobName, (content) => {
      if (content.startsWith("\x00")) {
        // Full snapshot replacement
        setLogs(content.slice(1).trimEnd());
      } else {
        setLogs((prev) => (prev + content).trimEnd());
      }
    });
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [transport, jobName]);

  const clearLogs = useCallback(() => {
    setLogs("");
  }, []);

  return { logs, clearLogs };
}
