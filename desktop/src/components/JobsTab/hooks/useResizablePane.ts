import { useCallback, useRef, useState } from "react";

export function useResizablePane() {
  const [listWidth, setListWidth] = useState(() => {
    const v = localStorage.getItem("desktop_list_pane_width");
    if (v) return Math.max(260, Math.min(600, parseInt(v, 10)));
    return 380;
  });
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const onResizeHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.pageX;
    const startW = listWidthRef.current;
    const onMouseMove = (ev: MouseEvent) => {
      const w = Math.max(260, Math.min(600, startW + (ev.pageX - startX)));
      setListWidth(w);
      localStorage.setItem("desktop_list_pane_width", String(w));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return { listWidth, onResizeHandleMouseDown };
}
