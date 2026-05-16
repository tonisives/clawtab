import { useMemo } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { RemoteJob, JobStatus, DetectedProcess, ProcessProvider } from "@clawtab/shared";

export interface MindItem {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  score: number;
  running: boolean;
  state: "running" | "idle" | "success" | "failed" | "paused";
  asking?: boolean;
  working?: boolean;
  provider?: ProcessProvider | null;
  job?: RemoteJob;
  status?: JobStatus;
  process?: DetectedProcess;
  paneId?: string;
}

export interface AgentNodeData extends Record<string, unknown> {
  item: MindItem;
  norm: number;
  size: number;
  width: number;
  height: number;
  opacity: number;
}

export interface GroupNodeData extends Record<string, unknown> {
  group: string;
  childCount: number;
  size: number;
  emphasis: number;
  onAdd?: (group: string, anchor: { x: number; y: number }) => void;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

const GROUP_RING_STEP = 560;
const AGENT_RADIUS_BASE = 230;
const AGENT_RADIUS_VARIATION = 56;
const LAYOUT_CLEARANCE = 34;
const SIZE_MIN = 88;
const SIZE_MAX = 132;
const AGENT_WIDTH_MIN = 150;
const AGENT_WIDTH_MAX = 220;
const AGENT_HEIGHT_MIN = 64;
const AGENT_HEIGHT_MAX = 88;
const OPACITY_MIN = 0.8;
const GROUP_SIZE_MIN = 120;
const GROUP_SIZE_MAX = 190;

interface RingSlot {
  ring: number;
  angle: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlapRect(a: Rect, b: Rect, margin = 0): boolean {
  return !(
    a.x + a.w + margin <= b.x ||
    b.x + b.w + margin <= a.x ||
    a.y + a.h + margin <= b.y ||
    b.y + b.h + margin <= a.y
  );
}

function pointInRect(p: { x: number; y: number }, r: Rect, margin = 0): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin;
}

function ccw(a: LayoutPosition, b: LayoutPosition, c: LayoutPosition): boolean {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: LayoutPosition, b: LayoutPosition, c: LayoutPosition, d: LayoutPosition): boolean {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function segmentCrossesRect(a: LayoutPosition, b: LayoutPosition, r: Rect, margin = 0): boolean {
  const rect = { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 };
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const tl = { x: rect.x, y: rect.y };
  const tr = { x: rect.x + rect.w, y: rect.y };
  const br = { x: rect.x + rect.w, y: rect.y + rect.h };
  const bl = { x: rect.x, y: rect.y + rect.h };
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  );
}

function pushRectAwayFromRect(rect: Rect, blocker: Rect): LayoutPosition {
  const left = blocker.x - (rect.x + rect.w);
  const right = blocker.x + blocker.w - rect.x;
  const top = blocker.y - (rect.y + rect.h);
  const bottom = blocker.y + blocker.h - rect.y;
  const options = [
    { x: left - LAYOUT_CLEARANCE, y: 0, d: Math.abs(left) },
    { x: right + LAYOUT_CLEARANCE, y: 0, d: Math.abs(right) },
    { x: 0, y: top - LAYOUT_CLEARANCE, d: Math.abs(top) },
    { x: 0, y: bottom + LAYOUT_CLEARANCE, d: Math.abs(bottom) },
  ];
  options.sort((a, b) => a.d - b.d);
  return { x: options[0].x, y: options[0].y };
}

function placeGroupsOnRings(count: number): RingSlot[] {
  const slots: RingSlot[] = [];
  if (count === 0) return slots;
  slots.push({ ring: 0, angle: 0 });
  let ring = 1;
  let placed = 1;
  while (placed < count) {
    const capacity = ring * 6;
    const take = Math.min(capacity, count - placed);
    for (let i = 0; i < take; i++) {
      const angle = -Math.PI / 2 + (i / take) * Math.PI * 2;
      slots.push({ ring, angle });
    }
    placed += take;
    ring += 1;
  }
  return slots;
}

function agentAngles(count: number, slot: RingSlot): number[] {
  const outwardAngle = slot.ring === 0 ? -Math.PI / 2 : slot.angle;
  const arc = slot.ring === 0 ? Math.PI * 2 : Math.PI;
  if (count <= 1) return [outwardAngle];
  const step = arc / Math.max(count, slot.ring === 0 ? count : 2);
  return Array.from({ length: count }, (_v, i) => outwardAngle + (i - (count - 1) / 2) * step);
}

function agentRadius(count: number, slot: RingSlot): number {
  if (count <= 1) return AGENT_RADIUS_BASE + (slot.ring === 0 ? 30 : 0);
  const arc = slot.ring === 0 ? Math.PI * 2 : Math.PI;
  const minGap = AGENT_WIDTH_MAX + LAYOUT_CLEARANCE;
  const step = arc / Math.max(count, slot.ring === 0 ? count : 2);
  const required = minGap / (2 * Math.sin(step / 2));
  return Math.max(AGENT_RADIUS_BASE + (slot.ring === 0 ? 30 : 0), required);
}

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

export interface OverrideMap {
  [nodeId: string]: LayoutPosition | undefined;
}

export function useRecencyLayout(
  items: MindItem[],
  overrides: OverrideMap = {},
  onGroupAdd?: (group: string, anchor: { x: number; y: number }) => void,
): LayoutResult {
  return useMemo(() => {
    if (items.length === 0) return { nodes: [], edges: [] };

    let minScore = Infinity;
    let maxScore = -Infinity;
    for (const it of items) {
      if (it.score < minScore) minScore = it.score;
      if (it.score > maxScore) maxScore = it.score;
    }
    const span = maxScore - minScore;
    const norm = (v: number) => (span > 0 ? (v - minScore) / span : 1);

    const byGroup = new Map<string, MindItem[]>();
    for (const it of items) {
      const arr = byGroup.get(it.group) ?? [];
      arr.push(it);
      byGroup.set(it.group, arr);
    }

    const groups = Array.from(byGroup.entries()).map(([name, list]) => {
      list.sort((a, b) => b.score - a.score);
      const maxChild = list[0]?.score ?? 0;
      return { name, items: list, maxChild };
    });
    groups.sort((a, b) => b.maxChild - a.maxChild);

    const slots = placeGroupsOnRings(groups.length);

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const occupiedRects: Rect[] = [];

    groups.forEach((group, gi) => {
      const slot = slots[gi];
      const groupRadius = slot.ring * GROUP_RING_STEP;
      const gxBase = Math.cos(slot.angle) * groupRadius;
      const gyBase = Math.sin(slot.angle) * groupRadius;
      const groupId = `group:${group.name}`;
      const emphasis = norm(group.maxChild);
      const groupSize = GROUP_SIZE_MIN + emphasis * (GROUP_SIZE_MAX - GROUP_SIZE_MIN);
      const groupOverride = overrides[groupId];
      const gx = groupOverride ? groupOverride.x + groupSize / 2 : gxBase;
      const gy = groupOverride ? groupOverride.y + groupSize / 2 : gyBase;

      const groupNode: Node<GroupNodeData> = {
        id: groupId,
        type: "groupHub",
        position: { x: gx - groupSize / 2, y: gy - groupSize / 2 },
        data: { group: group.name, childCount: group.items.length, size: groupSize, emphasis, onAdd: onGroupAdd },
        draggable: true,
        selectable: false,
      };
      nodes.push(groupNode);
      const groupRect: Rect = { x: groupNode.position.x, y: groupNode.position.y, w: groupSize, h: groupSize };
      occupiedRects.push(groupRect);

      const k = group.items.length;
      const angles = agentAngles(k, slot);
      const baseRadius = agentRadius(k, slot);
      const groupRects: Rect[] = [groupRect];
      const groupSegments: Array<{ from: LayoutPosition; to: LayoutPosition }> = [];

      group.items.forEach((item, i) => {
        const theta = angles[i] ?? (slot.ring === 0 ? -Math.PI / 2 : slot.angle);
        let radius = baseRadius + (i % 2) * AGENT_RADIUS_VARIATION;
        const n = norm(item.score);
        const size = SIZE_MIN + n * (SIZE_MAX - SIZE_MIN);
        const width = AGENT_WIDTH_MIN + n * (AGENT_WIDTH_MAX - AGENT_WIDTH_MIN);
        const height = AGENT_HEIGHT_MIN + n * (AGENT_HEIGHT_MAX - AGENT_HEIGHT_MIN);
        const opacity = OPACITY_MIN + n * (1 - OPACITY_MIN);
        let baseX = gx + Math.cos(theta) * radius;
        let baseY = gy + Math.sin(theta) * radius;
        const agentId = `agent:${item.id}`;
        const agentOverride = overrides[agentId];
        let px = agentOverride ? agentOverride.x : baseX - width / 2;
        let py = agentOverride ? agentOverride.y : baseY - height / 2;

        if (!agentOverride) {
          for (let attempt = 0; attempt < 16; attempt++) {
            const rect: Rect = { x: px, y: py, w: width, h: height };
            const center = { x: px + width / 2, y: py + height / 2 };
            const crossesNode = groupRects.some((r) => overlapRect(rect, r, LAYOUT_CLEARANCE));
            const crossesEdge = groupSegments.some((segment) => segmentCrossesRect(segment.from, segment.to, rect, LAYOUT_CLEARANCE / 2));
            const edgeHitsNode = groupRects.slice(1).some((r) => segmentCrossesRect({ x: gx, y: gy }, center, r, LAYOUT_CLEARANCE / 2));
            if (!crossesNode && !crossesEdge && !edgeHitsNode) break;
            radius += AGENT_RADIUS_VARIATION;
            baseX = gx + Math.cos(theta) * radius;
            baseY = gy + Math.sin(theta) * radius;
            px = baseX - width / 2;
            py = baseY - height / 2;
          }
        }

        for (let attempt = 0; attempt < 24 && !agentOverride; attempt++) {
          const rect: Rect = { x: px, y: py, w: width, h: height };
          const blocker = occupiedRects.find((r) => overlapRect(rect, r, LAYOUT_CLEARANCE));
          if (!blocker) break;
          const delta = pushRectAwayFromRect(rect, blocker);
          px += delta.x;
          py += delta.y;
          baseX = px + width / 2;
          baseY = py + height / 2;
        }

        const agentNode: Node<AgentNodeData> = {
          id: agentId,
          type: "agent",
          position: { x: px, y: py },
          data: { item, norm: n, size, width, height, opacity },
          draggable: true,
        };
        nodes.push(agentNode);
        const agentRect: Rect = { x: px, y: py, w: width, h: height };
        occupiedRects.push(agentRect);
        groupRects.push(agentRect);
        groupSegments.push({ from: { x: gx, y: gy }, to: { x: baseX, y: baseY } });

        // Edge handles: pick the nearest side of each endpoint based on
        // relative geometry so the line attaches sensibly (e.g. agent-bottom
        // to group-top when the agent sits above).
        const dx = baseX - gx;
        const dy = baseY - gy;
        const horizontal = Math.abs(dx) > Math.abs(dy);
        let sourceHandle: "t" | "b" | "l" | "r";
        let targetHandle: "t" | "b" | "l" | "r";
        if (horizontal) {
          sourceHandle = dx >= 0 ? "r" : "l";
          targetHandle = dx >= 0 ? "l" : "r";
        } else {
          sourceHandle = dy >= 0 ? "b" : "t";
          targetHandle = dy >= 0 ? "t" : "b";
        }
        edges.push({
          id: `e:${groupId}->${agentId}`,
          source: groupId,
          target: agentId,
          sourceHandle,
          targetHandle,
          animated: item.running,
          style: {
            stroke: item.running ? "rgb(48, 209, 88)" : "var(--border-color)",
            strokeWidth: item.running ? 2 : 1.25,
            opacity: 0.35 + n * 0.5,
          },
        });
      });
    });

    return { nodes, edges };
  }, [items, overrides, onGroupAdd]);
}
