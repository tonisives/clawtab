export type SurfaceMessage = {
  preview_ready?: boolean;
  token?: string;
  command?: Record<string, unknown>;
  native?: string;
  text?: string;
  gesture?: boolean;
  selection?: { start: number; end: number };
  id?: string;
  active?: boolean;
  height?: number;
  direction?: "up" | "down";
};

export type MessageSurfaceProps = {
  snapshot: Record<string, unknown>;
  active?: boolean;
  selection?: string | null;
  popup?: boolean;
  onCommand: (command: Record<string, unknown>) => Promise<unknown>;
  onNative?: (message: SurfaceMessage) => void;
};
