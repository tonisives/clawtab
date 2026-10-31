type Division = { x: number; y: number; width: number; height: number };

export function workspaceLayout(width: number, height: number, fontScale = 1, divisions: Division[] = []) {
  const scale = Math.max(1, fontScale);
  const listMinimum = 240 * scale;
  const detailMinimum = 360 * scale;
  const gutter = 5;
  const active = divisions.filter((region) => region.x < width && region.y < height
    && region.x + region.width > 0 && region.y + region.height > 0);
  const division = active.find((region) =>
    region.height >= height * 0.8 && region.width < region.height
    && region.x >= listMinimum && width - region.x - region.width >= detailMinimum,
  );
  // Keep a terminal off a horizontal fold or a division with too little room.
  const split = !!division || (active.length === 0 && width >= listMinimum + gutter + detailMinimum);
  const clearance = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!split && active.length) {
    const region = active[0];
    if (region.height > region.width) {
      if (width - region.x - region.width >= region.x) clearance.left = region.x + region.width;
      else clearance.right = width - region.x;
    } else {
      if (height - region.y - region.height > region.y) clearance.top = region.y + region.height;
      else clearance.bottom = height - region.y;
    }
  }
  return {
    split,
    listWidth: division ? division.x : Math.min(300 * scale, Math.max(listMinimum, width * 0.34)),
    gutterWidth: division ? division.width : gutter,
    clearance,
  };
}
