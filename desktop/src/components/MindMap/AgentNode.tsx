import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { JobKindIcon, type JobKind } from "@clawtab/shared";
import type { ProcessProvider } from "@clawtab/shared";
import type { AgentNodeData } from "./useRecencyLayout";

function providerToKind(provider: ProcessProvider | null | undefined): JobKind | null {
  if (!provider) return null;
  if (provider === "claude" || provider === "codex" || provider === "opencode") return provider;
  return null;
}

function AgentNodeImpl({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const item = d.item;
  const classes = [
    "mindmap-agent-node",
    `state-${item.state}`,
    item.asking ? "is-asking" : "",
    item.working ? "is-working" : "",
  ].filter(Boolean).join(" ");

  const kind = providerToKind(item.provider);

  return (
    <div
      className={classes}
      style={{ width: d.width, height: d.height, opacity: d.opacity }}
      title={item.sublabel ? `${item.label} — ${item.sublabel}` : item.label}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {item.working && <span className="mindmap-working-ring" aria-hidden="true" />}
      {kind && (
        <span className="mindmap-agent-provider" aria-hidden="true">
          <JobKindIcon kind={kind} size={16} compact bare />
        </span>
      )}
      <div className="mindmap-agent-text">
        <span className="label">{item.label}</span>
        {item.sublabel && <span className="sublabel">{item.sublabel}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

export const AgentNode = memo(AgentNodeImpl);
