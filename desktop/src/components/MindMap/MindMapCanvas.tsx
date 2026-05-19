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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GroupNode } from "./GroupNode";
import { AgentNode } from "./AgentNode";
import { AgentModal, type ModalRect } from "./AgentModal";
import { GroupSpawnPopup } from "./GroupSpawnPopup";
import { GearIcon } from "../icons";
import { EditTextDialog } from "../EditTextDialog";
import {
  useRecencyLayout,
  type AgentNodeData,
  type GroupNodeData,
  type MindItem,
  type OverrideMap,
  type LayoutPosition,
} from "./useRecencyLayout";
import type { useAutoYes } from "../../hooks/useAutoYes";
import type { ClaudeQuestion, DetectedProcess, ProcessProvider, ShellPane, Transport, useJobActions, useJobsCore } from "@clawtab/shared";
import { shortenPath } from "@clawtab/shared";
import {
  DEFAULT_SHORTCUTS,
  eventToShortcutBinding,
  resolveShortcutSettings,
  shortcutCompletesSequence,
  shortcutMatches,
  shortcutStartsWith,
  type ShortcutSettings,
} from "../../shortcuts";
import type { AppSettings } from "../../types";

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
  core: ReturnType<typeof useJobsCore>;
  actions: ReturnType<typeof useJobActions>;
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
const ENABLE_MODAL_NODE_NUDGE = false;
const MAX_MODAL_NUDGE = 160;
const MAX_MODAL_DEPTH = 180;
const MODAL_ATTRACTION_MARGIN = 26;
const MAX_MODAL_ATTRACTION = 220;
const COLLISION_MARGIN = 18;
const MAX_COLLISION_NUDGE = 260;
const MAX_GROUP_ROOT_OVERLAP = 74;

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
  core,
  actions,
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
  const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings>(DEFAULT_SHORTCUTS);
  const [renameDialog, setRenameDialog] = useState<{
    paneId: string;
    initialValue: string;
    placeholder?: string;
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
    startPosition: LayoutPosition;
    lastPosition: LayoutPosition;
    childStartPositions: Record<string, LayoutPosition>;
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
    wakeRef.current();
  }, [rf, layoutNodes]);
  useEffect(() => {
    rf.setEdges(edges);
    wakeRef.current();
  }, [rf, edges]);

  const nodeTypes = useMemo(() => ({ groupHub: GroupNode, agent: AgentNode }), []);

  const itemsById = useMemo(() => {
    const m = new Map<string, MindItem>();
    for (const it of effectiveItems) m.set(it.id, it);
    return m;
  }, [effectiveItems]);

  // Derived from `layoutNodes` directly. baseX/baseY here is only consulted
  // when there is no manual override (see the rAF loop), so reusing the
  // overridden position is harmless: the loop reads `mo.x` instead.
  const nodeBoxes = useMemo<NodeBox[]>(() => {
    return layoutNodes.map((n) => {
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
  }, [layoutNodes]);
  const nodeBoxesRef = useRef<NodeBox[]>([]);
  nodeBoxesRef.current = nodeBoxes;

  const repulsionRef = useRef<Record<string, LayoutPosition>>({});

  const sameConnectors = (a: ModalConnector[], b: ModalConnector[]) => (
    a.length === b.length && a.every((it, idx) => it.id === b[idx]?.id && it.path === b[idx]?.path)
  );

  // Gated animation loop. The tick runs only while something is in motion
  // (a drag, an unsettled repulsion offset) or while modal connectors need to
  // track node positions. When everything is settled and no modals are open,
  // the loop suspends itself; `wake()` re-arms it on drag start / modal
  // open / layout change.
  const wakeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let raf = 0;
    let running = false;
    const tick = () => {
      running = false;
      const inst = rf;
      const container = containerRef.current;
      if (!container) {
        schedule();
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const modalsArr = ENABLE_MODAL_NODE_NUDGE ? Object.values(modalsRef.current) : [];

      // When modals cover 50%+ of the viewport, there's nowhere to nudge nodes
      // to. Stop applying repulsion and let modals render on top instead.
      const viewportArea = containerRect.width * containerRect.height;
      let modalArea = 0;
      for (const m of modalsArr) modalArea += m.width * m.height;
      const skipRepulsion = viewportArea > 0 && modalArea / viewportArea >= 0.5;

      const modalsInFlow = !ENABLE_MODAL_NODE_NUDGE || skipRepulsion ? [] : Object.entries(modalsRef.current).map(([id, m]) => {
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

      // Reschedule only if there's still work for the next frame: an active
      // drag or an unsettled repulsion offset. Modal connectors are only
      // re-drawn when something explicitly wakes us (modal moved, viewport
      // panned/zoomed, node positions changed) - they don't need a steady
      // 60fps tick when nothing is moving.
      const hasRepulsion = Object.keys(repulsionRef.current).length > 0;
      const hasDrag = draggingRef.current.size > 0;
      if (hasRepulsion || hasDrag) {
        schedule();
      }
    };
    const schedule = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    wakeRef.current = schedule;
    // Initial pass: lays down edge handles + any startup connectors, then the
    // tick suspends itself when there's nothing pending.
    schedule();
    return () => {
      wakeRef.current = () => undefined;
      cancelAnimationFrame(raf);
    };
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
    wakeRef.current();
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
    wakeRef.current();
  }, [kind]);

  const handleChange = useCallback((id: string, rect: ModalRect) => {
    setModalsByKind((prevAll) => {
      const prev = prevAll[kind] ?? {};
      if (!prev[id]) return prevAll;
      return { ...prevAll, [kind]: { ...prev, [id]: rect } };
    });
    wakeRef.current();
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
      repulsionRef.current = {};
      setOverridesByKind((prev) => ({ ...prev, [kind]: {} }));
      const liveNodes = rf.getNodes();
      const childIds = liveNodes
        .filter((n) => n.type === "agent" && (n.data as AgentNodeData).item.group === group)
        .map((n) => n.id);
      for (const id of childIds) set.add(id);
      const childStartPositions: Record<string, LayoutPosition> = {};
      for (const child of liveNodes) {
        if (!childIds.includes(child.id)) continue;
        childStartPositions[child.id] = { x: child.position.x, y: child.position.y };
      }
      groupDragRef.current = {
        groupId: node.id,
        childIds,
        startPosition: { x: node.position.x, y: node.position.y },
        lastPosition: { x: node.position.x, y: node.position.y },
        childStartPositions,
      };
    } else {
      groupDragRef.current = null;
    }
    draggingRef.current = set;
    wakeRef.current();
  }, [kind, rf]);

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
            const totalDx = groupNode.position.x - groupDrag.startPosition.x;
            const totalDy = groupNode.position.y - groupDrag.startPosition.y;
            rf.setNodes((curr) => {
              return curr.map((n) => {
                if (!groupDrag.childIds.includes(n.id)) return n;
                const start = groupDrag.childStartPositions[n.id];
                if (!start) return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
                const target = { x: start.x + totalDx, y: start.y + totalDy };
                return {
                  ...n,
                  position: {
                    x: target.x,
                    y: target.y,
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

  // Load shortcut settings to interpret APP_SHORTCUT_EVENT bindings sent from
  // the focused xterm pane (paneShortcuts dispatches with the resolved binding).
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => setShortcutSettings(resolveShortcutSettings(s)))
      .catch(() => setShortcutSettings(DEFAULT_SHORTCUTS));
    const p = listen<AppSettings>("settings-updated", (event) => {
      setShortcutSettings(resolveShortcutSettings(event.payload));
    });
    return () => {
      p.then((fn) => fn());
    };
  }, []);

  // Resolve the focused modal's paneId for dispatched shortcuts that don't
  // carry a paneId (e.g. window-level keydown from outside the xterm).
  const orderRef = useRef<string[]>([]);
  orderRef.current = order;
  const itemsByIdRef = useRef<Map<string, MindItem>>(new Map());
  itemsByIdRef.current = itemsById;
  const shellModalsRef = useRef<ShellModalMap>({});
  shellModalsRef.current = shellModals;
  const processesRef = useRef<DetectedProcess[]>([]);
  processesRef.current = core.processes;

  const resolveFocusedPaneId = useCallback((): string | null => {
    const ord = orderRef.current;
    for (let i = ord.length - 1; i >= 0; i--) {
      const id = ord[i];
      const shellEntry = shellModalsRef.current[id];
      if (shellEntry) return shellEntry.shell.pane_id;
      const item = itemsByIdRef.current.get(id);
      if (item?.paneId) return item.paneId;
    }
    return null;
  }, []);

  const openRenameForPaneId = useCallback((paneId: string) => {
    const process = processesRef.current.find((p) => p.pane_id === paneId);
    if (!process) return;
    setRenameDialog({
      paneId,
      initialValue: process.display_name ?? process.pane_title ?? "",
      placeholder: shortenPath(process.cwd),
    });
  }, []);

  const handleSaveRename = useCallback(async (value: string) => {
    if (!renameDialog) return;
    const paneId = renameDialog.paneId;
    const displayName = value.trim() || null;
    setRenameDialog(null);
    try {
      core.setProcesses((prev) => prev.map((p) => (
        p.pane_id === paneId ? { ...p, display_name: displayName } : p
      )));
      await invoke("set_detected_process_display_name", { paneId, displayName });
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process name:", e);
    }
  }, [core, renameDialog]);

  // Resolve which modal currently owns a paneId (for kill/zoom actions).
  const modalIdForPaneId = useCallback((paneId: string): string | null => {
    for (const id of orderRef.current) {
      const shellEntry = shellModalsRef.current[id];
      if (shellEntry?.shell.pane_id === paneId) return id;
      const item = itemsByIdRef.current.get(id);
      if (item?.paneId === paneId) return id;
    }
    return null;
  }, []);

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  const handleChangeRef = useRef(handleChange);
  handleChangeRef.current = handleChange;
  const autoYesRef = useRef(autoYes);
  autoYesRef.current = autoYes;

  // Track per-modal pre-zoom rects so zoom-toggle can restore the original size.
  const preZoomRectsRef = useRef<Record<string, ModalRect>>({});

  const runEnterCopyMode = useCallback((paneId: string) => {
    console.log("[MindMap] runEnterCopyMode", { paneId });
    invoke("enter_copy_mode", { paneId })
      .then(() => console.log("[MindMap] enter_copy_mode OK", { paneId }))
      .catch((e) => console.error("[MindMap] enter_copy_mode FAIL", { paneId, error: e }));
  }, []);

  const runToggleAutoYes = useCallback((paneId: string) => {
    const ay = autoYesRef.current;
    const proc = processesRef.current.find((p) => p.pane_id === paneId);
    const title = proc?.display_name
      ?? proc?.matched_job
      ?? (proc?.cwd ? shortenPath(proc.cwd) : paneId);
    ay.handleToggleAutoYesByPaneId(paneId, title);
  }, []);

  const runKillPane = useCallback((paneId: string) => {
    const modalId = modalIdForPaneId(paneId);
    if (modalId) handleCloseRef.current(modalId);
    invoke("stop_detected_process", { paneId }).catch(console.error);
  }, [modalIdForPaneId]);

  const runZoomPane = useCallback((paneId: string) => {
    const modalId = modalIdForPaneId(paneId);
    if (!modalId) return;
    const current = modalsRef.current[modalId];
    if (!current) return;
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const stored = preZoomRectsRef.current[modalId];
    if (stored) {
      delete preZoomRectsRef.current[modalId];
      handleChangeRef.current(modalId, { ...stored, z: current.z });
      return;
    }
    preZoomRectsRef.current[modalId] = current;
    const fullscreen: ModalRect = {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
      z: current.z,
    };
    handleChangeRef.current(modalId, fullscreen);
  }, [modalIdForPaneId]);

  // Window-level keydown handler in capture phase. Runs BEFORE JobsTab's
  // listener and stops propagation for shortcuts that target a MindMap modal,
  // so JobsTab does not also act on a stale pane.
  const mindMapPendingStrokeRef = useRef<string | null>(null);
  useEffect(() => {
    const PANE_BINDING_IDS: Array<keyof ShortcutSettings> = [
      "rename_active_pane",
      "enter_copy_mode",
      "toggle_auto_yes",
      "kill_pane",
      "zoom_active_pane",
      "split_pane_vertical",
      "split_pane_horizontal",
      "move_pane_left",
      "move_pane_right",
      "move_pane_up",
      "move_pane_down",
      "resize_pane_left",
      "resize_pane_right",
      "resize_pane_up",
      "resize_pane_down",
      "reveal_in_sidebar",
      "toggle_sidebar",
      "next_sidebar_item",
      "previous_sidebar_item",
      "focus_agent_input",
      "back_navigation",
      "forward_navigation",
    ];

    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      (event as KeyboardEvent & { __clawtabShortcutHandled?: boolean }).__clawtabShortcutHandled = true;
    };

    const dispatchAction = (bindingId: keyof ShortcutSettings, paneId: string) => {
      switch (bindingId) {
        case "rename_active_pane":
          openRenameForPaneId(paneId);
          break;
        case "enter_copy_mode":
          runEnterCopyMode(paneId);
          break;
        case "toggle_auto_yes":
          runToggleAutoYes(paneId);
          break;
        case "kill_pane":
          runKillPane(paneId);
          break;
        case "zoom_active_pane":
          runZoomPane(paneId);
          break;
        default:
          // Intercepted but no-op so JobsTab doesn't act on a stale pane.
          break;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(".mindmap-modal-shell")) return;

      const paneId = resolveFocusedPaneId();
      if (!paneId) {
        console.log("[MindMap] keydown but no focused pane, key:", event.key);
        return;
      }

      if (mindMapPendingStrokeRef.current && event.key === "Escape") {
        mindMapPendingStrokeRef.current = null;
        consume(event);
        return;
      }

      const stroke = eventToShortcutBinding(event);
      const prefix = shortcutSettings.prefix_key;

      if (mindMapPendingStrokeRef.current) {
        if (!stroke) {
          consume(event);
          return;
        }
        const pending = mindMapPendingStrokeRef.current;
        const completed = PANE_BINDING_IDS.find((id) => (
          shortcutCompletesSequence(shortcutSettings[id], [pending, stroke], prefix)
        ));
        console.log("[MindMap] keydown second stroke", { pending, stroke, completed, paneId });
        if (completed) {
          mindMapPendingStrokeRef.current = null;
          consume(event);
          dispatchAction(completed, paneId);
          return;
        }
        const nextStart = PANE_BINDING_IDS.find((id) => (
          shortcutStartsWith(shortcutSettings[id], stroke, prefix)
        ));
        mindMapPendingStrokeRef.current = nextStart ? stroke : null;
        consume(event);
        return;
      }

      if (!stroke) return;

      const startsSequence = PANE_BINDING_IDS.find((id) => (
        shortcutStartsWith(shortcutSettings[id], stroke, prefix)
      ));
      if (startsSequence) {
        console.log("[MindMap] keydown first stroke", { stroke, startsSequence, paneId });
        mindMapPendingStrokeRef.current = stroke;
        consume(event);
        return;
      }

      const singleMatch = PANE_BINDING_IDS.find((id) => (
        shortcutMatches(event, shortcutSettings[id], prefix)
      ));
      if (singleMatch) {
        consume(event);
        dispatchAction(singleMatch, paneId);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [shortcutSettings, resolveFocusedPaneId, openRenameForPaneId, runEnterCopyMode, runToggleAutoYes, runKillPane, runZoomPane]);

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
        onMove={() => wakeRef.current()}
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
              transport={transport}
              core={core}
              actions={actions}
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
            transport={transport}
            core={core}
            actions={actions}
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
      {renameDialog && (
        <EditTextDialog
          title="Edit pane title"
          label="Title"
          initialValue={renameDialog.initialValue}
          placeholder={renameDialog.placeholder}
          onSave={handleSaveRename}
          onCancel={() => setRenameDialog(null)}
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
