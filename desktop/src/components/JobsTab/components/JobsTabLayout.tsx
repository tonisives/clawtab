import type { MouseEvent, ReactNode } from "react";
import { DndContext, DragOverlay, type DragCancelEvent, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import type { PaneContent, useSplitTree } from "@clawtab/shared";
import { SplitDetailArea } from "@clawtab/shared";

interface JobsTabLayoutProps {
  detailPane: ReactNode;
  dialogs: ReactNode;
  dragOverlayContent: ReactNode;
  dropOverlay: ReactNode;
  editorPaneClose: ReactNode;
  editorPaneMobile: ReactNode;
  folderRunnerPane?: ReactNode;
  isEditorVisible: boolean;
  isMainVisible: boolean;
  isPickerVisible: boolean;
  isWide: boolean;
  jobListView: ReactNode;
  listWidth: number;
  mobileShowsDetail: boolean;
  navBar?: ReactNode;
  onDragCancel: (event: DragCancelEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragMove: (event: DragMoveEvent) => void;
  onDragStart: (event: DragStartEvent) => void;
  onResizeHandleMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  pickerPaneClose: ReactNode;
  pickerPaneMobile: ReactNode;
  renderLeaf: (content: PaneContent, leafId: string) => ReactNode;
  rightPanelOverlay?: ReactNode;
  showFolderRunner: boolean;
  sidebarCollapsed: boolean;
  split: ReturnType<typeof useSplitTree>;
}

export function JobsTabLayout({
  detailPane,
  dialogs,
  dragOverlayContent,
  dropOverlay,
  editorPaneClose,
  editorPaneMobile,
  folderRunnerPane,
  isEditorVisible,
  isMainVisible,
  isPickerVisible,
  isWide,
  jobListView,
  listWidth,
  mobileShowsDetail,
  navBar,
  onDragCancel,
  onDragEnd,
  onDragMove,
  onDragStart,
  onResizeHandleMouseDown,
  pickerPaneClose,
  pickerPaneMobile,
  renderLeaf,
  rightPanelOverlay,
  showFolderRunner,
  sidebarCollapsed,
  split,
}: JobsTabLayoutProps) {
  return (
    <>
      <div style={{ display: !isWide && isEditorVisible ? undefined : "none", height: "100%" }}>
        {!isWide && isEditorVisible && editorPaneMobile}
      </div>

      <div style={{ display: !isWide && isPickerVisible ? undefined : "none", height: "100%" }}>
        {!isWide && isPickerVisible && pickerPaneMobile}
      </div>

      <div style={{ display: isMainVisible ? undefined : "none", height: "100%" }}>
        {!isWide ? (
          mobileShowsDetail ? (
            <div style={{ height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              {navBar}
              {detailPane}
              {dialogs}
            </div>
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {navBar}
              {jobListView}
              {dialogs}
            </div>
          )
        ) : (
          <DndContext
            sensors={split.sensors}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div style={{ display: "flex", flexDirection: "row", height: "100%", overflow: "hidden" }}>
              {!sidebarCollapsed && (
                <>
                  <div style={{ width: listWidth, minWidth: 260, maxWidth: 600, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    {navBar}
                    {jobListView}
                  </div>
                  <div onMouseDown={onResizeHandleMouseDown} style={{ width: 9, backgroundColor: "transparent", marginLeft: -5, marginRight: -4, zIndex: 10, cursor: "col-resize", flexShrink: 0, position: "relative" }} />
                </>
              )}
              <div ref={split.detailPaneRef} className="detail-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)", position: "relative" }}>
                {isEditorVisible ? (
                  editorPaneClose
                ) : isPickerVisible ? (
                  pickerPaneClose
                ) : showFolderRunner && !split.tree ? (
                  detailPane
                ) : (
                  <>
                    <SplitDetailArea
                      tree={split.tree}
                      renderLeaf={renderLeaf}
                      onRatioChange={split.handleSplitRatioChange}
                      onFocusLeaf={split.setFocusedLeafId}
                      focusedLeafId={split.focusedLeafId}
                      paneColors={split.paneColors}
                      minPaneSize={200}
                      emptyContent={detailPane}
                      overlay={dropOverlay}
                    />
                    {showFolderRunner && (
                      <div style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 20,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(0, 0, 0, 0.7)",
                        backdropFilter: "blur(4px)",
                      }}>
                        {folderRunnerPane}
                      </div>
                    )}
                  </>
                )}
                {rightPanelOverlay}
              </div>
              {dialogs}
            </div>
            <DragOverlay dropAnimation={null}>{dragOverlayContent}</DragOverlay>
          </DndContext>
        )}
      </div>
    </>
  );
}
