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
}

export interface LayoutPosition {
  x: number;
  y: number;
}

const GROUP_RING_STEP = 540;
const AGENT_RADIUS_BASE = 230;
const AGENT_RADIUS_VARIATION = 56;
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

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

export interface OverrideMap {
  [nodeId: string]: LayoutPosition | undefined;
}

export function useRecencyLayout(items: MindItem[], overrides: OverrideMap = {}): LayoutResult {
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
        data: { group: group.name, childCount: group.items.length, size: groupSize, emphasis },
        draggable: true,
        selectable: false,
      };
      nodes.push(groupNode);

      const k = group.items.length;
      const outwardAngle = slot.ring === 0 ? -Math.PI / 2 : slot.angle;
      const arc = slot.ring === 0 ? Math.PI * 2 : Math.PI;
      const denom = Math.max(k, slot.ring === 0 ? 8 : 4);

      group.items.forEach((item, i) => {
        const offset = (i - (k - 1) / 2) * (arc / denom);
        const theta = outwardAngle + offset;
        const radius = AGENT_RADIUS_BASE + (i % 2) * AGENT_RADIUS_VARIATION + (slot.ring === 0 ? 30 : 0);
        const n = norm(item.score);
        const size = SIZE_MIN + n * (SIZE_MAX - SIZE_MIN);
        const width = AGENT_WIDTH_MIN + n * (AGENT_WIDTH_MAX - AGENT_WIDTH_MIN);
        const height = AGENT_HEIGHT_MIN + n * (AGENT_HEIGHT_MAX - AGENT_HEIGHT_MIN);
        const opacity = OPACITY_MIN + n * (1 - OPACITY_MIN);
        const baseX = gx + Math.cos(theta) * radius;
        const baseY = gy + Math.sin(theta) * radius;
        const agentId = `agent:${item.id}`;
        const agentOverride = overrides[agentId];
        const px = agentOverride ? agentOverride.x : baseX - width / 2;
        const py = agentOverride ? agentOverride.y : baseY - height / 2;

        const agentNode: Node<AgentNodeData> = {
          id: agentId,
          type: "agent",
          position: { x: px, y: py },
          data: { item, norm: n, size, width, height, opacity },
          draggable: true,
        };
        nodes.push(agentNode);

        edges.push({
          id: `e:${groupId}->${agentId}`,
          source: groupId,
          target: agentId,
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
  }, [items, overrides]);
}
