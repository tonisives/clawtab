export type PaneContent =
  | { kind: "job"; slug: string }
  | { kind: "process"; paneId: string }
  | { kind: "agent" };

export type SplitNode =
  | { type: "leaf"; id: string; content: PaneContent }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

export type SplitDirection = "horizontal" | "vertical";

export type SplitTreeState = SplitNode | null;
