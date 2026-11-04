type Bounds = { x: number; y: number; width: number; height: number };
type Insets = { left: number; right: number; bottom: number };

// Native navigation may already keep a pane inside the window's safe area.
export function remainingSafeArea(bounds: Bounds, window: { width: number; height: number }, insets: Insets): Insets {
  return {
    left: Math.max(0, insets.left - bounds.x),
    right: Math.max(0, bounds.x + bounds.width - window.width + insets.right),
    bottom: Math.max(0, bounds.y + bounds.height - window.height + insets.bottom),
  };
}
