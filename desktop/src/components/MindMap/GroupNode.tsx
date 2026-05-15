import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GroupNodeData } from "./useRecencyLayout";

function GroupNodeImpl({ data }: NodeProps) {
  const d = data as GroupNodeData;
  const classes = ["mindmap-group-node", d.emphasis >= 0.95 ? "is-center" : ""].filter(Boolean).join(" ");
  const handleAddClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    d.onAdd?.(d.group, { x: rect.left, y: rect.bottom });
  };
  return (
    <div
      className={classes}
      style={{ width: d.size, height: d.size }}
      title={d.group}
    >
      <Handle id="t" type="source" position={Position.Top} style={{ opacity: 0, top: 0 }} />
      <Handle id="b" type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />
      <Handle id="l" type="source" position={Position.Left} style={{ opacity: 0, left: 0 }} />
      <Handle id="r" type="source" position={Position.Right} style={{ opacity: 0, right: 0 }} />
      <span className="name">{d.group}</span>
      <span className="child-count">{d.childCount}</span>
      {d.onAdd ? (
        <button
          type="button"
          className="mindmap-group-add-inner"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleAddClick}
          title={`New agent or shell in ${d.group}`}
        >
          +
        </button>
      ) : null}
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
