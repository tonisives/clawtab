import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
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
import { GroupSpawnPopup } from "./GroupSpawnPopup";
import { GearIcon } from "../icons";
import {
  useRecencyLayout,
  type AgentNodeData,
  type GroupNodeData,
  type MindItem,
  type OverrideMap,
  type LayoutPosition,
} from "./useRecencyLayout";
import type { useAutoYes } from "../../hooks/useAutoYes";
import type { ClaudeQuestion, ProcessProvider, ShellPane, Transport } from "@clawtab/shared";

interface FolderGroup {
  group: string;
  folderPath: string;
}

type MindMapKind = "agents" | "jobs";

interface Props {
  kind: MindMapKind;
  items: MindItem[];
  questions: ClaudeQuestion[];
  autoYes: ReturnType<typeof useAutoYes>;
  transport: Transport;
  folderGroups: FolderGroup[];
  onDismissQuestion: (questionId: string) => void;
  onRequestJobsTab: () => void;
}

const DEFAULT_W = 720;
const DEFAULT_H = 520;
const MIN_W = 360;
const MIN_H = 260;
const GAP = 12;
const REPULSION_MARGIN = 24;
const SPRING = 0.2;
const MAX_MODAL_NUDGE = 160;
const MAX_MODAL_DEPTH = 180;
const MODAL_ATTRACTION_MARGIN = 26;
const MAX_MODAL_ATTRACTION = 220;
const COLLISION_MARGIN = 18;
const MAX_COLLISION_NUDGE = 260;
const MAX_GROUP_ROOT_OVERLAP = 74;
const LEAF_FAN_GAP = 16;
const LEAF_FAN_ROW_GAP = 14;
const LEAF_FAN_ROOT_GAP = 24;
const LEAF_FAN_EASE = 0.44;
const LEAF_FAN_COLLISION_MARGIN = 12;

type FanSide = "top" | "right" | "bottom" | "left";

interface FlowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FlowSegment {
  from: LayoutPosition;
  to: LayoutPosition;
}

function rectOverlap(a: FlowRect, b: FlowRect): { x: number; y: number } {
  return {
    x: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
}

function ccw(a: LayoutPosition, b: LayoutPosition, c: LayoutPosition): boolean {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: LayoutPosition, b: LayoutPosition, c: LayoutPosition, d: LayoutPosition): boolean {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function segmentCrossesRect(segment: FlowSegment, rect: FlowRect, margin = 0): boolean {
  const r = { x: rect.x - margin, y: rect.y - margin, w: rect.w + margin * 2, h: rect.h + margin * 2 };
  const pointInside = (p: LayoutPosition) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (pointInside(segment.from) || pointInside(segment.to)) return true;
  const tl = { x: r.x, y: r.y };
  const tr = { x: r.x + r.w, y: r.y };
  const br = { x: r.x + r.w, y: r.y + r.h };
  const bl = { x: r.x, y: r.y + r.h };
  return (
    segmentsIntersect(segment.from, segment.to, tl, tr) ||
    segmentsIntersect(segment.from, segment.to, tr, br) ||
    segmentsIntersect(segment.from, segment.to, br, bl) ||
    segmentsIntersect(segment.from, segment.to, bl, tl)
  );
}

function pushAwayFromRect(rect: FlowRect, blocker: FlowRect): LayoutPosition {
  const overlap = rectOverlap(rect, blocker);
  if (overlap.x <= -COLLISION_MARGIN || overlap.y <= -COLLISION_MARGIN) return { x: 0, y: 0 };
  const dx = rect.x + rect.w / 2 - (blocker.x + blocker.w / 2);
  const dy = rect.y + rect.h / 2 - (blocker.y + blocker.h / 2);
  if (overlap.x < overlap.y) {
    return { x: (dx >= 0 ? 1 : -1) * Math.min(MAX_COLLISION_NUDGE, overlap.x + COLLISION_MARGIN), y: 0 };
  }
  return { x: 0, y: (dy >= 0 ? 1 : -1) * Math.min(MAX_COLLISION_NUDGE, overlap.y + COLLISION_MARGIN) };
}

function nodeRect(n: Node): FlowRect | null {
  if (n.type === "agent") {
    const d = n.data as AgentNodeData;
    return { x: n.position.x, y: n.position.y, w: d.width, h: d.height };
  }
  if (n.type === "groupHub") {
    const d = n.data as GroupNodeData;
    return { x: n.position.x, y: n.position.y, w: d.size, h: d.size };
  }
  return null;
}

function sideAngle(side: FanSide): number {
  if (side === "right") return 0;
  if (side === "bottom") return Math.PI / 2;
  if (side === "left") return Math.PI;
  return -Math.PI / 2;
}

function preferredFanSide(rootCenter: LayoutPosition, groupRects: FlowRect[]): FanSide {
  if (groupRects.length <= 1) return "top";
  const centers = groupRects.map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  const minY = Math.min(...centers.map((c) => c.y));
  const maxY = Math.max(...centers.map((c) => c.y));
  const minX = Math.min(...centers.map((c) => c.x));
  const maxX = Math.max(...centers.map((c) => c.x));
  const verticalBand = Math.max(160, (maxY - minY) * 0.18);
  const horizontalBand = Math.max(180, (maxX - minX) * 0.16);
  if (rootCenter.y <= minY + verticalBand) return "top";
  if (rootCenter.y >= maxY - verticalBand) return "bottom";
  if (rootCenter.x <= minX + horizontalBand) return "left";
  if (rootCenter.x >= maxX - horizontalBand) return "right";

  const spaces = [
    { side: "top" as FanSide, value: rootCenter.y - minY },
    { side: "bottom" as FanSide, value: maxY - rootCenter.y },
    { side: "left" as FanSide, value: rootCenter.x - minX },
    { side: "right" as FanSide, value: maxX - rootCenter.x },
  ];
  spaces.sort((a, b) => b.value - a.value);
  return spaces[0].side;
}

function compactLeafFanTargets(
  rootNode: Node,
  children: Node[],
  rootSize: number,
  side: FanSide,
): Map<string, LayoutPosition> {
  const targets = new Map<string, LayoutPosition>();
  const rootCenter = {
    x: rootNode.position.x + rootSize / 2,
    y: rootNode.position.y + rootSize / 2,
  };
  const count = children.length;
  if (count === 0) return targets;
  const maxChildW = children.reduce((max, child) => {
    const d = child.data as AgentNodeData;
    return Math.max(max, d.width);
  }, 0);
  const maxChildH = children.reduce((max, child) => {
    const d = child.data as AgentNodeData;
    return Math.max(max, d.height);
  }, 0);
  const perLine = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(count * 1.4))));
  const majorGap = rootSize / 2 + LEAF_FAN_ROOT_GAP;
  children.forEach((child, index) => {
    const d = child.data as AgentNodeData;
    const line = Math.floor(index / perLine);
    const lineStart = line * perLine;
    const lineCount = Math.min(perLine, count - lineStart);
    const inLine = index - lineStart;
    const cross = (inLine - (lineCount - 1) / 2);
    const lineInset = line * Math.min(28, (maxChildW + LEAF_FAN_GAP) * 0.12);
    if (side === "top" || side === "bottom") {
      const direction = side === "top" ? -1 : 1;
      const x = rootCenter.x + cross * (maxChildW + LEAF_FAN_GAP) + (line % 2 === 0 ? 0 : lineInset) - d.width / 2;
      const y = rootCenter.y + direction * (majorGap + maxChildH / 2 + line * (maxChildH + LEAF_FAN_ROW_GAP)) - d.height / 2;
      targets.set(child.id, { x, y });
      return;
    }
    const direction = side === "left" ? -1 : 1;
    const x = rootCenter.x + direction * (majorGap + maxChildW / 2 + line * (maxChildW + LEAF_FAN_ROW_GAP)) - d.width / 2;
    const y = rootCenter.y + cross * (maxChildH + LEAF_FAN_GAP) + (line % 2 === 0 ? 0 : lineInset) - d.height / 2;
    targets.set(child.id, {
      x,
      y,
    });
  });
  return targets;
}

function scoreLeafFanTargets(
  rootCenter: LayoutPosition,
  children: Node[],
  targets: Map<string, LayoutPosition>,
  side: FanSide,
  preferred: FanSide,
  obstacles: Array<FlowRect & { id: string; type: Node["type"] }>,
): number {
  const rects = children.map((child) => {
    const d = child.data as AgentNodeData;
    const pos = targets.get(child.id) ?? child.position;
    return { id: child.id, x: pos.x, y: pos.y, w: d.width, h: d.height };
  });
  let score = side === preferred ? 0 : 900;
  const angleDelta = Math.abs(Math.atan2(Math.sin(sideAngle(side) - sideAngle(preferred)), Math.cos(sideAngle(side) - sideAngle(preferred))));
  score += angleDelta > Math.PI / 2 ? 900 : 0;

  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    score += Math.hypot(ac.x - rootCenter.x, ac.y - rootCenter.y) * 0.12;
    const edge = { from: rootCenter, to: ac };

    for (let j = i + 1; j < rects.length; j++) {
      const overlap = rectOverlap(a, rects[j]);
      if (overlap.x > -LEAF_FAN_COLLISION_MARGIN && overlap.y > -LEAF_FAN_COLLISION_MARGIN) {
        score += 10000 + Math.max(0, overlap.x) * Math.max(0, overlap.y);
      }
    }
    for (const blocker of obstacles) {
      const overlap = rectOverlap(a, blocker);
      if (overlap.x > -LEAF_FAN_COLLISION_MARGIN && overlap.y > -LEAF_FAN_COLLISION_MARGIN) {
        score += blocker.type === "groupHub" ? 22000 : 14000;
        score += Math.max(0, overlap.x) * Math.max(0, overlap.y);
      }
      if (segmentCrossesRect(edge, blocker, LEAF_FAN_COLLISION_MARGIN / 2)) {
        score += blocker.type === "groupHub" ? 6000 : 3200;
      }
    }
  }
  return score;
}

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
  type: Node["type"];
  baseX: number;
  baseY: number;
  width: number;
  height: number;
}

interface ModalConnector {
  id: string;
  path: string;
}

// Pluggable modal kind: "item" for existing mind items, "shell" for freshly
// spawned shells that haven't been promoted to a DetectedProcess yet.
interface ShellModalEntry {
  kind: "shell";
  shell: ShellPane;
  label: string;
  group: string;
}
type ShellModalMap = Record<string, ShellModalEntry>;

const EMPTY_MODALS: Record<string, ModalRect> = {};
const EMPTY_ORDER: string[] = [];
const EMPTY_OVERRIDES: OverrideMap = {};
const EMPTY_SHELL_MODALS: ShellModalMap = {};

function CanvasInner({
  kind,
  items,
  questions,
  autoYes,
  transport,
  folderGroups,
  onDismissQuestion,
  onRequestJobsTab,
}: Props) {
  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [modalsByKind, setModalsByKind] = useState<Record<MindMapKind, Record<string, ModalRect>>>({ agents: {}, jobs: {} });
  const [orderByKind, setOrderByKind] = useState<Record<MindMapKind, string[]>>({ agents: [], jobs: [] });
  const [overridesByKind, setOverridesByKind] = useState<Record<MindMapKind, OverrideMap>>({ agents: {}, jobs: {} });
  const [shellModalsByKind, setShellModalsByKind] = useState<Record<MindMapKind, ShellModalMap>>({ agents: {}, jobs: {} });
  const [modalConnectors, setModalConnectors] = useState<ModalConnector[]>([]);
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);
  const [spawnPopup, setSpawnPopup] = useState<{
    group: string;
    folderPath?: string;
    anchor: { x: number; y: number };
  } | null>(null);

  const modals = modalsByKind[kind] ?? EMPTY_MODALS;
  const order = orderByKind[kind] ?? EMPTY_ORDER;
  const manualOverrides = overridesByKind[kind] ?? EMPTY_OVERRIDES;
  const shellModals = shellModalsByKind[kind] ?? EMPTY_SHELL_MODALS;

  const modalsRef = useRef<Record<string, ModalRect>>({});
  modalsRef.current = modals;
  const manualRef = useRef<OverrideMap>({});
  manualRef.current = manualOverrides;
  const draggingRef = useRef<Set<string>>(new Set());
  const groupDragRef = useRef<{
    groupId: string;
    childIds: string[];
    lastPosition: LayoutPosition;
  } | null>(null);

  // Group + button click: anchor popup to the button's screen position.
  const handleGroupAdd = useCallback((group: string, anchorScreen: { x: number; y: number }) => {
    const folderPath = folderGroups.find((g) => g.group === group)?.folderPath;
    setSpawnPopup({ group, folderPath, anchor: anchorScreen });
  }, [folderGroups]);

  // Add synthetic items for freshly spawned panes until a real detected process arrives for the same paneId.
  const effectiveItems = useMemo<MindItem[]>(() => {
    const realPaneIds = new Set<string>();
    for (const it of items) if (it.paneId) realPaneIds.add(it.paneId);
    const extras: MindItem[] = [];
    for (const [id, entry] of Object.entries(shellModals)) {
      if (realPaneIds.has(entry.shell.pane_id)) continue;
      extras.push({
        id,
        label: entry.label,
        sublabel: entry.shell.cwd,
        group: entry.group,
        score: Date.now(),
        running: true,
        state: "running",
        paneId: entry.shell.pane_id,
      });
    }
    return extras.length === 0 ? items : [...items, ...extras];
  }, [items, shellModals]);

  const { nodes: layoutNodes, edges } = useRecencyLayout(effectiveItems, manualOverrides, handleGroupAdd);

  // Push layout into ReactFlow store. Merge: preserve in-flight drag positions,
  // accept new layout for everything else. The RAF loop will re-apply repulsion
  // on top each frame.
  useEffect(() => {
    rf.setNodes((curr) => {
      const currById = new Map(curr.map((n) => [n.id, n]));
      const dragging = draggingRef.current;
      return layoutNodes.map((ln) => {
        const existing = currById.get(ln.id);
        if (!existing) return ln;
        if (dragging.has(ln.id)) {
          return { ...existing, data: ln.data };
        }
        return { ...ln, selected: existing.selected };
      });
    });
  }, [rf, layoutNodes]);
  useEffect(() => {
    rf.setEdges(edges);
  }, [rf, edges]);

  const nodeTypes = useMemo(() => ({ groupHub: GroupNode, agent: AgentNode }), []);

  const itemsById = useMemo(() => {
    const m = new Map<string, MindItem>();
    for (const it of effectiveItems) m.set(it.id, it);
    return m;
  }, [effectiveItems]);

  const { nodes: baseNodes } = useRecencyLayout(effectiveItems, {});
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
      return { id: n.id, type: n.type, baseX: n.position.x, baseY: n.position.y, width: w, height: h };
    });
  }, [baseNodes]);
  const nodeBoxesRef = useRef<NodeBox[]>([]);
  nodeBoxesRef.current = nodeBoxes;

  const repulsionRef = useRef<Record<string, LayoutPosition>>({});

  const sameConnectors = (a: ModalConnector[], b: ModalConnector[]) => (
    a.length === b.length && a.every((it, idx) => it.id === b[idx]?.id && it.path === b[idx]?.path)
  );

  // Animation loop. Computes target repulsion against *base* position (not
  // current displaced position) so a node pushed out of a modal stays pushed
  // - no oscillation as it crosses the boundary while springing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const inst = rf;
      const container = containerRef.current;
      if (!container) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const modalsArr = Object.values(modalsRef.current);

      // When modals cover 50%+ of the viewport, there's nowhere to nudge nodes
      // to. Stop applying repulsion and let modals render on top instead.
      const viewportArea = containerRect.width * containerRect.height;
      let modalArea = 0;
      for (const m of modalsArr) modalArea += m.width * m.height;
      const skipRepulsion = viewportArea > 0 && modalArea / viewportArea >= 0.5;

      const modalsInFlow = skipRepulsion ? [] : Object.entries(modalsRef.current).map(([id, m]) => {
        const a = inst.screenToFlowPosition({ x: containerRect.left + m.x, y: containerRect.top + m.y });
        const b = inst.screenToFlowPosition({ x: containerRect.left + m.x + m.width, y: containerRect.top + m.y + m.height });
        return {
          id,
          x: Math.min(a.x, b.x) - REPULSION_MARGIN,
          y: Math.min(a.y, b.y) - REPULSION_MARGIN,
          w: Math.abs(b.x - a.x) + REPULSION_MARGIN * 2,
          h: Math.abs(b.y - a.y) + REPULSION_MARGIN * 2,
        };
      });

      const manual = manualRef.current;
      const dragging = draggingRef.current;
      const prev = repulsionRef.current;
      const next: Record<string, LayoutPosition> = {};
      let anyChange = false;
      const liveNodesForRepulsion = inst.getNodes();
      const liveByIdForRepulsion = new Map(liveNodesForRepulsion.map((n) => [n.id, n]));
      const boxById = new Map(nodeBoxesRef.current.map((box) => [box.id, box]));
      const draggedRects = nodeBoxesRef.current
        .filter((box) => dragging.has(box.id))
        .map((box) => {
          const pos = liveByIdForRepulsion.get(box.id)?.position;
          if (!pos) return null;
          return {
            id: box.id,
            type: box.type,
            x: pos.x,
            y: pos.y,
            w: box.width,
            h: box.height,
          };
        })
        .filter((it): it is FlowRect & { id: string; type: Node["type"] } => Boolean(it));
      const draggedEdges: FlowSegment[] = [];
      for (const edge of inst.getEdges()) {
        if (!dragging.has(edge.source) && !dragging.has(edge.target)) continue;
        const source = liveByIdForRepulsion.get(edge.source);
        const target = liveByIdForRepulsion.get(edge.target);
        const sourceBox = boxById.get(edge.source);
        const targetBox = boxById.get(edge.target);
        if (!source || !target || !sourceBox || !targetBox) continue;
        draggedEdges.push({
          from: { x: source.position.x + sourceBox.width / 2, y: source.position.y + sourceBox.height / 2 },
          to: { x: target.position.x + targetBox.width / 2, y: target.position.y + targetBox.height / 2 },
        });
      }

      for (const box of nodeBoxesRef.current) {
        if (dragging.has(box.id)) continue;
        const mo = manual[box.id];
        const baseX = mo ? mo.x : box.baseX;
        const baseY = mo ? mo.y : box.baseY;
        // Compute push relative to BASE position - decouples target from the
        // node's current (displaced) position so it doesn't ping-pong across
        // the boundary while springing back.
        const baseCx = baseX + box.width / 2;
        const baseCy = baseY + box.height / 2;

        let tx = 0;
        let ty = 0;
        for (const m of modalsInFlow) {
          const inside =
            baseCx >= m.x && baseCx <= m.x + m.w && baseCy >= m.y && baseCy <= m.y + m.h;
          if (!inside) continue;
          const distLeft = baseCx - m.x;
          const distRight = m.x + m.w - baseCx;
          const distTop = baseCy - m.y;
          const distBottom = m.y + m.h - baseCy;
          const minDist = Math.min(distLeft, distRight, distTop, distBottom);
          if (minDist > MAX_MODAL_DEPTH) continue;
          if (minDist === distLeft) tx -= Math.min(MAX_MODAL_NUDGE, distLeft + box.width / 2);
          else if (minDist === distRight) tx += Math.min(MAX_MODAL_NUDGE, distRight + box.width / 2);
          else if (minDist === distTop) ty -= Math.min(MAX_MODAL_NUDGE, distTop + box.height / 2);
          else ty += Math.min(MAX_MODAL_NUDGE, distBottom + box.height / 2);
        }

        if (box.type === "agent") {
          const modal = modalsInFlow.find((m) => `agent:${m.id}` === box.id);
          if (modal) {
            const modalCx = modal.x + modal.w / 2;
            const modalCy = modal.y + modal.h / 2;
            const dx = modalCx - baseCx;
            const dy = modalCy - baseCy;
            let targetX = baseX;
            let targetY = baseY;
            if (Math.abs(dx) >= Math.abs(dy)) {
              targetX = dx >= 0
                ? modal.x - box.width - MODAL_ATTRACTION_MARGIN
                : modal.x + modal.w + MODAL_ATTRACTION_MARGIN;
              targetY = modalCy - box.height / 2;
            } else {
              targetX = modalCx - box.width / 2;
              targetY = dy >= 0
                ? modal.y - box.height - MODAL_ATTRACTION_MARGIN
                : modal.y + modal.h + MODAL_ATTRACTION_MARGIN;
            }
            const attractX = Math.max(-MAX_MODAL_ATTRACTION, Math.min(MAX_MODAL_ATTRACTION, targetX - baseX));
            const attractY = Math.max(-MAX_MODAL_ATTRACTION, Math.min(MAX_MODAL_ATTRACTION, targetY - baseY));
            tx += (attractX - tx) * 0.72;
            ty += (attractY - ty) * 0.72;
          }
        }

        if (draggedRects.length > 0 || draggedEdges.length > 0) {
          const rect = { x: baseX + tx, y: baseY + ty, w: box.width, h: box.height };
          for (const blocker of draggedRects) {
            const delta = pushAwayFromRect(rect, blocker);
            tx += delta.x;
            ty += delta.y;
            rect.x = baseX + tx;
            rect.y = baseY + ty;
          }
          for (const segment of draggedEdges) {
            if (!segmentCrossesRect(segment, rect, COLLISION_MARGIN / 2)) continue;
            const segCx = (segment.from.x + segment.to.x) / 2;
            const segCy = (segment.from.y + segment.to.y) / 2;
            const dx = rect.x + rect.w / 2 - segCx;
            const dy = rect.y + rect.h / 2 - segCy;
            if (Math.abs(dx) > Math.abs(dy)) {
              tx += (dx >= 0 ? 1 : -1) * Math.min(MAX_COLLISION_NUDGE, rect.w / 2 + COLLISION_MARGIN);
            } else {
              ty += (dy >= 0 ? 1 : -1) * Math.min(MAX_COLLISION_NUDGE, rect.h / 2 + COLLISION_MARGIN);
            }
            rect.x = baseX + tx;
            rect.y = baseY + ty;
          }
        }

        const p = prev[box.id] ?? { x: 0, y: 0 };
        const nx = p.x + (tx - p.x) * SPRING;
        const ny = p.y + (ty - p.y) * SPRING;
        const settled = tx === 0 && ty === 0 && Math.abs(nx) < 0.3 && Math.abs(ny) < 0.3;
        if (!settled) {
          next[box.id] = { x: nx, y: ny };
          if (!prev[box.id] || Math.abs(nx - p.x) > 0.05 || Math.abs(ny - p.y) > 0.05) anyChange = true;
        } else if (prev[box.id]) {
          anyChange = true;
        }
      }

      repulsionRef.current = next;

      if (anyChange) {
        inst.setNodes((curr) =>
          curr.map((n) => {
            if (dragging.has(n.id)) return n;
            const box = nodeBoxesRef.current.find((b) => b.id === n.id);
            if (!box) return n;
            const mo = manual[n.id];
            const baseX = mo ? mo.x : box.baseX;
            const baseY = mo ? mo.y : box.baseY;
            const off = next[n.id] ?? { x: 0, y: 0 };
            const targetX = baseX + off.x;
            const targetY = baseY + off.y;
            if (Math.abs(n.position.x - targetX) < 0.05 && Math.abs(n.position.y - targetY) < 0.05) return n;
            return { ...n, position: { x: targetX, y: targetY } };
          }),
        );
      }

      // Recompute edge handles based on current node centers so edges always
      // attach to the side of each endpoint that faces the other endpoint.
      const liveNodes = inst.getNodes();
      const centers = new Map<string, { cx: number; cy: number; w: number; h: number }>();
      for (const n of liveNodes) {
        let w = 0, h = 0;
        const t = n.type;
        if (t === "agent") {
          const d = n.data as AgentNodeData;
          w = d.width;
          h = d.height;
        } else if (t === "groupHub") {
          const d = n.data as GroupNodeData;
          w = d.size;
          h = d.size;
        }
        centers.set(n.id, {
          cx: n.position.x + w / 2,
          cy: n.position.y + h / 2,
          w,
          h,
        });
      }
      let edgesChanged = false;
      const newEdges = inst.getEdges().map((e) => {
        const s = centers.get(e.source);
        const t = centers.get(e.target);
        if (!s || !t) return e;
        const dx = t.cx - s.cx;
        const dy = t.cy - s.cy;
        const horizontal = Math.abs(dx) > Math.abs(dy);
        let sh: "t" | "b" | "l" | "r";
        let th: "t" | "b" | "l" | "r";
        if (horizontal) {
          sh = dx >= 0 ? "r" : "l";
          th = dx >= 0 ? "l" : "r";
        } else {
          sh = dy >= 0 ? "b" : "t";
          th = dy >= 0 ? "t" : "b";
        }
        if (e.sourceHandle === sh && e.targetHandle === th) return e;
        edgesChanged = true;
        return { ...e, sourceHandle: sh, targetHandle: th };
      });
      if (edgesChanged) inst.setEdges(newEdges);

      const openModals = modalsRef.current;
      const connectors: ModalConnector[] = [];
      for (const [id, modal] of Object.entries(openModals)) {
        const center = centers.get(`agent:${id}`);
        if (!center) continue;
        const centerScreen = inst.flowToScreenPosition({ x: center.cx, y: center.cy });
        const cx = centerScreen.x - containerRect.left;
        const cy = centerScreen.y - containerRect.top;
        const hooks: Array<{ x: number; y: number }> = [];
        for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
          hooks.push({ x: modal.x + modal.width * pct, y: modal.y });
          hooks.push({ x: modal.x + modal.width * pct, y: modal.y + modal.height });
          hooks.push({ x: modal.x, y: modal.y + modal.height * pct });
          hooks.push({ x: modal.x + modal.width, y: modal.y + modal.height * pct });
        }
        let targetHook = hooks[0];
        let targetDist = Infinity;
        for (const hook of hooks) {
          const dist = Math.hypot(hook.x - cx, hook.y - cy);
          if (dist < targetDist) {
            targetHook = hook;
            targetDist = dist;
          }
        }
        const flowHalfW = center.w / 2;
        const flowHalfH = center.h / 2;
        const rightScreen = inst.flowToScreenPosition({ x: center.cx + flowHalfW, y: center.cy });
        const bottomScreen = inst.flowToScreenPosition({ x: center.cx, y: center.cy + flowHalfH });
        const halfW = Math.abs(rightScreen.x - centerScreen.x);
        const halfH = Math.abs(bottomScreen.y - centerScreen.y);
        const dx = targetHook.x - cx;
        const dy = targetHook.y - cy;
        let sx = cx;
        let sy = cy;
        if (halfW > 0 && halfH > 0) {
          const scale = Math.min(
            Math.abs(dx) > 0 ? halfW / Math.abs(dx) : Infinity,
            Math.abs(dy) > 0 ? halfH / Math.abs(dy) : Infinity,
          );
          if (Number.isFinite(scale)) {
            sx = cx + dx * scale;
            sy = cy + dy * scale;
          }
        }
        const tx = targetHook.x;
        const ty = targetHook.y;
        const c1x = sx + (tx - sx) * 0.45;
        const c1y = sy;
        const c2x = sx + (tx - sx) * 0.55;
        const c2y = ty;
        connectors.push({
          id,
          path: `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`,
        });
      }
      setModalConnectors((prev) => sameConnectors(prev, connectors) ? prev : connectors);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rf]);

  const placeModal = useCallback((id: string) => {
    setModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      if (prev[id]) {
        setOrderByKind((ordAll) => ({ ...ordAll, [kind]: [...(ordAll[kind] ?? []).filter((x) => x !== id), id] }));
        return prevAll;
      }
      const bounds = containerRef.current?.getBoundingClientRect() ?? { width: 1200, height: 800 };
      const existing = Object.values(prev);
      const w = Math.min(DEFAULT_W, Math.max(MIN_W, bounds.width - 32));
      const h = Math.min(DEFAULT_H, Math.max(MIN_H, bounds.height - 32));
      const pos = findPlacement(existing, w, h, { width: bounds.width, height: bounds.height });
      const nextZ = existing.reduce((m, r) => Math.max(m, r.z), 0) + 1;
      const rect: ModalRect = { x: pos.x, y: pos.y, width: w, height: h, z: nextZ };
      setOrderByKind((ordAll) => ({ ...ordAll, [kind]: [...(ordAll[kind] ?? []).filter((x) => x !== id), id] }));
      return { ...prevAll, [kind]: { ...prev, [id]: rect } };
    });
  }, [kind]);

  const handleNodeClick: NodeMouseHandler = useCallback((event, node: Node) => {
    if (event.shiftKey) return;
    if (node.type !== "agent") return;
    const data = node.data as AgentNodeData;
    placeModal(data.item.id);
  }, [placeModal]);

  const handleClose = useCallback((id: string) => {
    setModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      if (!prev[id]) return prevAll;
      const next = { ...prev };
      delete next[id];
      return { ...prevAll, [kind]: next };
    });
    setOrderByKind((ordAll) => ({ ...ordAll, [kind]: (ordAll[kind] ?? []).filter((x) => x !== id) }));
    setShellModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      if (!prev[id]) return prevAll;
      const next = { ...prev };
      delete next[id];
      return { ...prevAll, [kind]: next };
    });
  }, [kind]);

  const handleChange = useCallback((id: string, rect: ModalRect) => {
    setModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      if (!prev[id]) return prevAll;
      return { ...prevAll, [kind]: { ...prev, [id]: rect } };
    });
  }, [kind]);

  const handleFocus = useCallback((id: string) => {
    setModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      const cur = prev[id];
      if (!cur) return prevAll;
      const maxZ = Object.values(prev).reduce((m, r) => Math.max(m, r.z), 0);
      if (cur.z === maxZ) return prevAll;
      return { ...prevAll, [kind]: { ...prev, [id]: { ...cur, z: maxZ + 1 } } };
    });
    setOrderByKind((ordAll) => ({ ...ordAll, [kind]: [...(ordAll[kind] ?? []).filter((x) => x !== id), id] }));
  }, [kind]);

  const handleNodeDragStart: OnNodeDrag = useCallback((_event, node, nodes) => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.id);
    set.add(node.id);
    if (node.type === "groupHub") {
      const group = (node.data as GroupNodeData).group;
      const childIds = rf.getNodes()
        .filter((n) => n.type === "agent" && (n.data as AgentNodeData).item.group === group)
        .map((n) => n.id);
      for (const id of childIds) set.add(id);
      groupDragRef.current = {
        groupId: node.id,
        childIds,
        lastPosition: { x: node.position.x, y: node.position.y },
      };
    } else {
      groupDragRef.current = null;
    }
    draggingRef.current = set;
  }, [rf]);

  const handleNodeDrag: OnNodeDrag = useCallback((_event, _node, nodes) => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.id);
    const groupDrag = groupDragRef.current;
    if (groupDrag) {
      const groupNode = nodes.find((n) => n.id === groupDrag.groupId) ?? rf.getNode(groupDrag.groupId);
      if (groupNode) {
        const dx = groupNode.position.x - groupDrag.lastPosition.x;
        const dy = groupNode.position.y - groupDrag.lastPosition.y;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          const d = groupNode.data as GroupNodeData;
          const candidateRect: FlowRect = { x: groupNode.position.x, y: groupNode.position.y, w: d.size, h: d.size };
          const tooDeep = rf.getNodes().some((n) => {
            if (n.id === groupDrag.groupId || n.type !== "groupHub") return false;
            const other = n.data as GroupNodeData;
            const overlap = rectOverlap(candidateRect, { x: n.position.x, y: n.position.y, w: other.size, h: other.size });
            return overlap.x > MAX_GROUP_ROOT_OVERLAP && overlap.y > MAX_GROUP_ROOT_OVERLAP;
          });
          if (tooDeep) {
            rf.setNodes((curr) => curr.map((n) => (
              n.id === groupDrag.groupId
                ? { ...n, position: groupDrag.lastPosition }
                : n
            )));
          } else {
            const rootCenter = {
              x: groupNode.position.x + d.size / 2,
              y: groupNode.position.y + d.size / 2,
            };
            rf.setNodes((curr) => {
              const draggedIds = new Set([groupDrag.groupId, ...groupDrag.childIds]);
              const children = groupDrag.childIds
                .map((id) => curr.find((n) => n.id === id))
                .filter((n): n is Node => Boolean(n));
              const groupRects = curr
                .filter((n) => n.type === "groupHub")
                .map(nodeRect)
                .filter((rect): rect is FlowRect => Boolean(rect));
              const obstacles = curr
                .filter((n) => !draggedIds.has(n.id))
                .map((n) => {
                  const rect = nodeRect(n);
                  return rect ? { ...rect, id: n.id, type: n.type } : null;
                })
                .filter((rect): rect is FlowRect & { id: string; type: Node["type"] } => Boolean(rect));
              const preferred = preferredFanSide(rootCenter, groupRects);
              let bestTargets = compactLeafFanTargets(groupNode, children, d.size, preferred);
              let bestScore = scoreLeafFanTargets(rootCenter, children, bestTargets, preferred, preferred, obstacles);
              for (const side of ["top", "bottom", "left", "right"] as FanSide[]) {
                if (side === preferred) continue;
                const candidate = compactLeafFanTargets(groupNode, children, d.size, side);
                const score = scoreLeafFanTargets(rootCenter, children, candidate, side, preferred, obstacles);
                if (score < bestScore) {
                  bestScore = score;
                  bestTargets = candidate;
                }
              }
              return curr.map((n) => {
                if (!groupDrag.childIds.includes(n.id)) return n;
                const target = bestTargets.get(n.id);
                if (!target) return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
                return {
                  ...n,
                  position: {
                    x: n.position.x + (target.x - n.position.x) * LEAF_FAN_EASE,
                    y: n.position.y + (target.y - n.position.y) * LEAF_FAN_EASE,
                  },
                };
              });
            });
            groupDragRef.current = {
              ...groupDrag,
              lastPosition: { x: groupNode.position.x, y: groupNode.position.y },
            };
          }
        }
      }
      set.add(groupDrag.groupId);
      for (const id of groupDrag.childIds) set.add(id);
    }
    draggingRef.current = set;
  }, [rf]);

  const handleNodeDragStop: OnNodeDrag = useCallback((_event, node, nodes) => {
    setOverridesByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      const next = { ...prev };
      const groupDrag = groupDragRef.current;
      const liveById = new Map(rf.getNodes().map((n) => [n.id, n]));
      const all = nodes.length > 0 ? [...nodes] : [node];
      if (groupDrag) {
        const liveGroup = liveById.get(groupDrag.groupId);
        if (liveGroup) all.push(liveGroup);
        all.push(...groupDrag.childIds.map((id) => liveById.get(id)).filter((n): n is Node => Boolean(n)));
      }
      const seen = new Set<string>();
      for (const n of all) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        const off = repulsionRef.current[n.id] ?? { x: 0, y: 0 };
        next[n.id] = { x: n.position.x - off.x, y: n.position.y - off.y };
      }
      return { ...prevAll, [kind]: next };
    });
    const groupDrag = groupDragRef.current;
    const draggedIds = new Set((nodes.length > 0 ? nodes : [node]).map((n) => n.id));
    if (groupDrag) {
      draggedIds.add(groupDrag.groupId);
      for (const id of groupDrag.childIds) draggedIds.add(id);
    }
    for (const id of draggedIds) {
      delete repulsionRef.current[id];
    }
    groupDragRef.current = null;
    draggingRef.current = new Set();
  }, [kind, rf]);

  const handleSelectionDragStop = useCallback((_event: React.MouseEvent, nodes: Node[]) => {
    setOverridesByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      const next = { ...prev };
      for (const n of nodes) {
        const off = repulsionRef.current[n.id] ?? { x: 0, y: 0 };
        next[n.id] = { x: n.position.x - off.x, y: n.position.y - off.y };
      }
      return { ...prevAll, [kind]: next };
    });
    for (const n of nodes) {
      delete repulsionRef.current[n.id];
    }
    draggingRef.current = new Set();
  }, [kind]);

  const handleSpawn = useCallback(async (provider: ProcessProvider | "shell", modelId: string | null, workDir: string, group: string) => {
    setSpawnPopup(null);
    const result = await transport.runAgent("", workDir, provider, modelId ?? undefined);
    if (!result) return;
    const paneId = result.pane_id;
    const shell: ShellPane = {
      pane_id: paneId,
      cwd: workDir,
      tmux_session: result.tmux_session,
      window_name: "",
      matched_group: group,
    };
    const modalId = `pane:${paneId}`;
    setShellModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      return {
        ...prevAll,
        [kind]: {
          ...prev,
          [modalId]: {
            kind: "shell",
            shell,
            label: provider === "shell" ? "Terminal" : `${provider}`,
            group,
          },
        },
      };
    });
    placeModal(modalId);
  }, [kind, transport, placeModal]);

  const handleResetLayout = useCallback(() => {
    draggingRef.current = new Set();
    groupDragRef.current = null;
    repulsionRef.current = {};
    setMapSettingsOpen(false);
    setOverridesByKind((prev) => ({ ...prev, [kind]: {} }));
    requestAnimationFrame(() => {
      rf.fitView({ padding: 0.2, duration: 260 });
    });
  }, [kind, rf]);

  return (
    <div className="mindmap-canvas" ref={containerRef}>
      <ReactFlow
        defaultNodes={layoutNodes}
        defaultEdges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStop={handleSelectionDragStop}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        panOnScroll
        zoomOnPinch
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        multiSelectionKeyCode="Shift"
        selectionKeyCode="Shift"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} showZoom={false} />
      </ReactFlow>
      <div className="mindmap-map-settings">
        {mapSettingsOpen && (
          <div className="mindmap-map-settings-menu">
            <button type="button" onClick={handleResetLayout}>
              Reset layout
            </button>
          </div>
        )}
        <button
          type="button"
          className="mindmap-map-settings-trigger"
          aria-label="Mind map settings"
          aria-expanded={mapSettingsOpen}
          onClick={() => setMapSettingsOpen((open) => !open)}
        >
          <GearIcon size={16} />
        </button>
      </div>
      <svg className="mindmap-modal-connectors" aria-hidden="true">
        {modalConnectors.map((connector) => (
          <path key={connector.id} d={connector.path} />
        ))}
      </svg>
      {order.map((id) => {
        const item = itemsById.get(id);
        const shellEntry = shellModals[id];
        const rect = modals[id];
        if (!rect) return null;
        if (shellEntry) {
          const ephemeralItem: MindItem = {
            id,
            label: shellEntry.label,
            sublabel: shellEntry.shell.cwd,
            group: shellEntry.group,
            score: Date.now(),
            running: true,
            state: "running",
            paneId: shellEntry.shell.pane_id,
          };
          return (
            <AgentModal
              key={id}
              item={ephemeralItem}
              shell={shellEntry.shell}
              rect={rect}
              containerRef={containerRef}
              questions={questions}
              autoYes={autoYes}
              onDismissQuestion={onDismissQuestion}
              onClose={handleClose}
              onChange={handleChange}
              onFocus={handleFocus}
              onRequestJobsTab={onRequestJobsTab}
              onStopped={handleClose}
            />
          );
        }
        if (!item) return null;
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
            onStopped={handleClose}
          />
        );
      })}
      {spawnPopup && (
        <GroupSpawnPopup
          group={spawnPopup.group}
          folderPath={spawnPopup.folderPath}
          anchor={spawnPopup.anchor}
          transport={transport}
          onSpawn={handleSpawn}
          onClose={() => setSpawnPopup(null)}
        />
      )}
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
