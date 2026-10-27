export type SurfaceMessage = {
  preview_ready?: boolean;
  token?: string;
  command?: Record<string, unknown>;
  native?: string;
  active?: boolean;
  height?: number;
};

export type MessageSurfaceProps = {
  snapshot: Record<string, unknown>;
  selection?: string | null;
  onCommand: (command: Record<string, unknown>) => Promise<unknown>;
  onNative?: (message: SurfaceMessage) => void;
};
