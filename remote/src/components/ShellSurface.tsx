import { useCallback, useMemo } from "react";
import { useIsFocused } from "expo-router/react-navigation";
import { capturedShellCommand, capturedShellSnapshot } from "../lib/capturedShell";
import { MessageSurface } from "./MessageSurface";
import type { SurfaceMessage } from "./messageSurfaceTypes";

export function ShellSurface({ paneId, onScrollGesture }: { paneId: string; onScrollGesture?: (direction: "up" | "down") => void }) {
  const focused = useIsFocused();
  const snapshot = useMemo(() => capturedShellSnapshot(paneId, focused), [paneId, focused]);
  const onCommand = useMemo(() => capturedShellCommand(paneId), [paneId]);
  const onNative = useCallback((message: SurfaceMessage) => {
    if (message.native === "shell_scroll" && message.direction) onScrollGesture?.(message.direction);
  }, [onScrollGesture]);
  return <MessageSurface key={paneId} snapshot={snapshot} selection={paneId} active={focused} onCommand={onCommand} onNative={onNative} />;
}
