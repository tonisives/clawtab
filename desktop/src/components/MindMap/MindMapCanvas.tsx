import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GroupNode } from "./GroupNode";
import { AgentNode } from "./AgentNode";
import { AgentModal, type ModalRect } from "./AgentModal";
import {
  useRecencyLayout,
  type AgentNodeData,
  type GroupNodeData,
  type MindItem,
  type OverrideMap,
  type LayoutPosition,
} from "./useRecencyLayout";
import type { useAutoYes } from "../../hooks/useAutoYes";
import type { ClaudeQuestion } from "@clawtab/shared";

interface Props {
  items: MindItem[];
  questions: ClaudeQuestion[];
  autoYes: ReturnType<typeof useAutoYes>;
  onDismissQuestion: (questionId: string) => void;
  onRequestJobsTab: () => void;
}

function RecenterButton() {
  const { fitView } = useReactFlow();
  return (
    <ControlButton
      onClick={() => fitView({ padding: 0.2, duration: 400 })}
      title="Recenter"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
        <line x1="12" y1="2" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="2" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="22" y2="12" />
      </svg>
    </ControlButton>
  );
}

const DEFAULT_W = 720;
const DEFAULT_H = 520;
const MIN_W = 360;
const MIN_H = 260;
const GAP = 12;
const REPULSION_MARGIN = 28;
const SPRING = 0.18;

function rectsOverlap(a: ModalRect, b: ModalRect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function findPlacement(
  existing: ModalRect[],
  width: number,
  height: number,
  bounds: { width: number; height: number },
): { x: number; y: number } {
  if (existing.length === 0) {
    return {
      x: Math.max(0, (bounds.width - width) / 2),
      y: Math.max(0, (bounds.height - height) / 2),
    };
  }
  const candidates: Array<{ x: number; y: number }> = [];
  for (const r of existing) {
    candidates.push({ x: r.x + r.width + GAP, y: r.y });
    candidates.push({ x: r.x - width - GAP, y: r.y });
    candidates.push({ x: r.x, y: r.y + r.height + GAP });
    candidates.push({ x: r.x, y: r.y - height - GAP });
  }
  for (const c of candidates) {
    if (c.x < 0 || c.y < 0) continue;
    if (c.x + width > bounds.width) continue;
    if (c.y + height > bounds.height) continue;
    const test: ModalRect = { x: c.x, y: c.y, width, height, z: 0 };
    if (existing.every((r) => !rectsOverlap(r, test))) return { x: c.x, y: c.y };
  }
  const last = existing[existing.length - 1];
  const cascadeOffset = 24;
  let x = Math.min(last.x + cascadeOffset, Math.max(0, bounds.width - width));
  let y = Math.min(last.y + cascadeOffset, Math.max(0, bounds.height - height));
  if (x + width > bounds.width) x = Math.max(0, bounds.width - width);
  if (y + height > bounds.height) y = Math.max(0, bounds.height - height);
  return { x, y };
}

interface NodeBox {
  id: string;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
}

function CanvasInner({ items, questions, autoYes, onDismissQuestion, onRequestJobsTab }: Props) {
  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [modals, setModals] = useState<Record<string, ModalRect>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [manualOverrides, setManualOverrides] = useState<OverrideMap>({});
  const [repulsion, setRepulsion] = useState<OverrideMap>({});

  const mergedOverrides = useMemo<OverrideMap>(() => {
    const out: OverrideMap = {};
    for (const k of Object.keys(manualOverrides)) out[k] = manualOverrides[k];
    for (const k of Object.keys(repulsion)) {
      const existing = out[k];
      const r = repulsion[k];
      if (!r) continue;
      out[k] = existing
        ? { x: existing.x + r.x, y: existing.y + r.y }
        : { x: r.x, y: r.y };
    }
    return out;
  }, [manualOverrides, repulsion]);

  const { nodes, edges } = useRecencyLayout(items, mergedOverrides);

  const nodeTypes = useMemo(() => ({ groupHub: GroupNode, agent: AgentNode }), []);

  const itemsById = useMemo(() => {
    const m = new Map<string, MindItem>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  // Build base node boxes (no overrides) for repulsion math.
  const { nodes: baseNodes } = useRecencyLayout(items, {});
  const nodeBoxes = useMemo<NodeBox[]>(() => {
    return baseNodes.map((n) => {
      let w = 0;
      let h = 0;
      if (n.type === "agent") {
        const d = n.data as AgentNodeData;
        w = d.width;
        h = d.height;
      } else if (n.type === "groupHub") {
        const d = n.data as GroupNodeData;
        w = d.size;
        h = d.size;
      }
      return { id: n.id, baseX: n.position.x, baseY: n.position.y, width: w, height: h };
    });
  }, [baseNodes]);

  // Animation loop: compute target repulsion from current modal rects + node base
  // positions, then smoothly interpolate.
  const targetRepulsionRef = useRef<OverrideMap>({});
  const rafRef = useRef<number | null>(null);
  const reactFlowInstanceRef = useRef(rf);
  reactFlowInstanceRef.current = rf;

  useEffect(() => {
    const compute = () => {
      const inst = reactFlowInstanceRef.current;
      const container = containerRef.current;
      if (!container) {
        targetRepulsionRef.current = {};
        return;
      }
      const containerRect = container.getBoundingClientRect();
      // Convert each modal (container-relative px) to flow coordinates.
      const modalsInFlow = Object.values(modals).map((m) => {
        const screenA = { x: containerRect.left + m.x, y: containerRect.top + m.y };
        const screenB = { x: containerRect.left + m.x + m.width, y: containerRect.top + m.y + m.height };
        const a = inst.screenToFlowPosition(screenA);
        const b = inst.screenToFlowPosition(screenB);
        return {
          x: Math.min(a.x, b.x) - REPULSION_MARGIN,
          y: Math.min(a.y, b.y) - REPULSION_MARGIN,
          w: Math.abs(b.x - a.x) + REPULSION_MARGIN * 2,
          h: Math.abs(b.y - a.y) + REPULSION_MARGIN * 2,
        };
      });

      const next: OverrideMap = {};
      for (const box of nodeBoxes) {
        // Apply any manual override first when measuring current position.
        const mo = manualOverrides[box.id];
        const cx = (mo ? mo.x : box.baseX) + box.width / 2;
        const cy = (mo ? mo.y : box.baseY) + box.height / 2;
        let dx = 0;
        let dy = 0;
        for (const m of modalsInFlow) {
          const mxCenter = m.x + m.w / 2;
          const myCenter = m.y + m.h / 2;
          // Closest point on rect to node center.
          const cxClamped = Math.max(m.x, Math.min(cx, m.x + m.w));
          const cyClamped = Math.max(m.y, Math.min(cy, m.y + m.h));
          const inside = cxClamped === cx && cyClamped === cy;
          if (!inside) continue;
          // Push toward nearest side of the modal.
          const distLeft = cx - m.x;
          const distRight = m.x + m.w - cx;
          const distTop = cy - m.y;
          const distBottom = m.y + m.h - cy;
          const minDist = Math.min(distLeft, distRight, distTop, distBottom);
          if (minDist === distLeft) dx -= distLeft + box.width / 2;
          else if (minDist === distRight) dx += distRight + box.width / 2;
          else if (minDist === distTop) dy -= distTop + box.height / 2;
          else dy += distBottom + box.height / 2;
          // Tiny center bias to avoid two-modal stalemate
          dx += (cx - mxCenter) * 0.05;
          dy += (cy - myCenter) * 0.05;
        }
        if (dx !== 0 || dy !== 0) next[box.id] = { x: dx, y: dy };
      }
      targetRepulsionRef.current = next;
    };

    const tick = () => {
      compute();
      setRepulsion((prev) => {
        const target = targetRepulsionRef.current;
        const ids = new Set<string>([...Object.keys(prev), ...Object.keys(target)]);
        const next: OverrideMap = {};
        let changed = false;
        for (const id of ids) {
          const p = prev[id] ?? { x: 0, y: 0 };
          const t = target[id] ?? { x: 0, y: 0 };
          const nx = p.x + (t.x - p.x) * SPRING;
          const ny = p.y + (t.y - p.y) * SPRING;
          if (Math.abs(nx) < 0.5 && Math.abs(ny) < 0.5) {
            if (prev[id]) changed = true;
            continue;
          }
          if (!prev[id] || Math.abs(nx - p.x) > 0.05 || Math.abs(ny - p.y) > 0.05) changed = true;
          next[id] = { x: nx, y: ny };
        }
        return changed ? next : prev;
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [modals, nodeBoxes, manualOverrides]);

  const handleNodeClick: NodeMouseHandler = useCallback((_event, node: Node) => {
    if (node.type !== "agent") return;
    const data = node.data as AgentNodeData;
    const id = data.item.id;

    setModals((prev) => {
      if (prev[id]) {
        setOrder((ord) => [...ord.filter((x) => x !== id), id]);
        return prev;
      }
      const bounds = containerRef.current?.getBoundingClientRect() ?? { width: 1200, height: 800 };
      const existing = Object.values(prev);
      const w = Math.min(DEFAULT_W, Math.max(MIN_W, bounds.width - 32));
      const h = Math.min(DEFAULT_H, Math.max(MIN_H, bounds.height - 32));
      const pos = findPlacement(existing, w, h, { width: bounds.width, height: bounds.height });
      const nextZ = existing.reduce((m, r) => Math.max(m, r.z), 0) + 1;
      const rect: ModalRect = { x: pos.x, y: pos.y, width: w, height: h, z: nextZ };
      setOrder((ord) => [...ord.filter((x) => x !== id), id]);
      return { ...prev, [id]: rect };
    });
  }, []);

  const handleClose = useCallback((id: string) => {
    setModals((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setOrder((ord) => ord.filter((x) => x !== id));
  }, []);

  const handleChange = useCallback((id: string, rect: ModalRect) => {
    setModals((prev) => (prev[id] ? { ...prev, [id]: rect } : prev));
  }, []);

  const handleFocus = useCallback((id: string) => {
    setModals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const maxZ = Object.values(prev).reduce((m, r) => Math.max(m, r.z), 0);
      if (cur.z === maxZ) return prev;
      return { ...prev, [id]: { ...cur, z: maxZ + 1 } };
    });
    setOrder((ord) => [...ord.filter((x) => x !== id), id]);
  }, []);

  const handleNodeDragStop: OnNodeDrag = useCallback((_event, node) => {
    const pos: LayoutPosition = { x: node.position.x, y: node.position.y };
    setManualOverrides((prev) => ({ ...prev, [node.id]: pos }));
  }, []);

  return (
    <div className="mindmap-canvas" ref={containerRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        panOnScroll
        zoomOnPinch
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false}>
          <RecenterButton />
        </Controls>
      </ReactFlow>
      {order.map((id) => {
        const item = itemsById.get(id);
        const rect = modals[id];
        if (!item || !rect) return null;
        return (
          <AgentModal
            key={id}
            item={item}
            rect={rect}
            containerRef={containerRef}
            questions={questions}
            autoYes={autoYes}
            onDismissQuestion={onDismissQuestion}
            onClose={handleClose}
            onChange={handleChange}
            onFocus={handleFocus}
            onRequestJobsTab={onRequestJobsTab}
          />
        );
      })}
    </div>
  );
}

export function MindMapCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
