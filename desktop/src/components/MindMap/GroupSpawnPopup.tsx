import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JobKindIcon } from "@clawtab/shared";
import type { ProcessProvider, Transport } from "@clawtab/shared";
import { buildModelOptions } from "../JobEditor/utils";

interface Props {
  group: string;
  folderPath?: string;
  anchor: { x: number; y: number };
  transport: Transport;
  onSpawn: (provider: ProcessProvider | "shell", modelId: string | null, workDir: string, group: string) => void | Promise<void>;
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
      if (!ref.current.contains(e.target as Node)) onClose();
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
  const launchable = modelOptions.filter((opt) => opt.provider !== "shell");

  const handlePick = useCallback(async (provider: ProcessProvider | "shell", modelId: string | null) => {
    if (sending) return;
    if (!folderPath) {
      onClose();
      return;
    }
    setSending(true);
    try {
      await onSpawn(provider, modelId, folderPath, group);
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
          {launchable.map((opt) => (
            <button
              key={`${opt.provider}:${opt.modelId ?? ""}`}
              className="mindmap-spawn-item"
              disabled={sending}
              onClick={() => { void handlePick(opt.provider, opt.modelId); }}
            >
              <span className="ic"><JobKindIcon kind={opt.provider} size={16} compact bare /></span>
              <span className="lb">{opt.label}</span>
            </button>
          ))}
          <button
            className="mindmap-spawn-item"
            disabled={sending}
            onClick={() => { void handlePick("shell", null); }}
          >
            <span className="ic"><JobKindIcon kind="shell" size={16} compact bare /></span>
            <span className="lb">Terminal</span>
          </button>
        </div>
      )}
    </div>
  );
}
