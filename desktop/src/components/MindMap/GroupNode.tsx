import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GroupNodeData } from "./useRecencyLayout";

function GroupNodeImpl({ data }: NodeProps) {
  const d = data as GroupNodeData;
  const classes = ["mindmap-group-node", d.emphasis >= 0.95 ? "is-center" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      style={{ width: d.size, height: d.size }}
      title={d.group}
    >
      <Handle type="source" position={Position.Top} style={{ opacity: 0 }} />
      <span className="name">{d.group}</span>
      <span className="child-count">{d.childCount}</span>
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
