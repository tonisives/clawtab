import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSelector } from "@clawtab/shared";
import type { AgentEffort, ProcessProvider, Transport } from "@clawtab/shared";
import { buildModelOptions } from "../JobEditor/utils";

interface Props {
  group: string;
  folderPath?: string;
  anchor: { x: number; y: number };
  transport: Transport;
  onSpawn: (provider: ProcessProvider, modelId: string | null, effort: AgentEffort | null, workDir: string, group: string) => void | Promise<void>;
  onClose: () => void;
}

export function GroupSpawnPopup({ group, folderPath, anchor, transport, onSpawn, onClose }: Props) {
  const [providers, setProviders] = useState<ProcessProvider[]>([]);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    transport.listAgentProviders?.()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [transport]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      const target = e.target as HTMLElement;
      if (target.closest?.("[data-popup-menu='true']")) return;
      if (!ref.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const modelOptions = useMemo(() => buildModelOptions(providers, {}), [providers]);

  const handlePick = useCallback(async (provider: ProcessProvider, modelId: string | null, effort: AgentEffort | null) => {
    if (sending) return;
    if (!folderPath) {
      onClose();
      return;
    }
    setSending(true);
    try {
      await onSpawn(provider, modelId, effort, folderPath, group);
    } finally {
      setSending(false);
    }
  }, [folderPath, group, onClose, onSpawn, sending]);

  return (
    <div
      ref={ref}
      className="mindmap-spawn-popup"
      style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 200 }}
      role="menu"
    >
      <div className="mindmap-spawn-popup-title">
        <div className="mindmap-spawn-popup-title-row">
          <span>New in <strong>{group}</strong></span>
          <button
            type="button"
            className="mindmap-spawn-popup-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            {"×"}
          </button>
        </div>
        {folderPath ? <div className="mindmap-spawn-popup-path">{folderPath}</div> : null}
      </div>
      {!folderPath ? (
        <div className="mindmap-spawn-popup-empty">
          No folder is known for this group. Open it in Jobs first.
        </div>
      ) : (
        <div className="mindmap-spawn-popup-items">
          <AgentSelector
            modelOptions={modelOptions}
            includeShell
            fullWidth
            label="Choose agent"
            disabled={sending}
            onChange={(selection) => handlePick(selection.provider, selection.modelId, selection.effort)}
          />
        </div>
      )}
    </div>
  );
}
