import type { ReactNode } from "react";
import type { PaneContent } from "@clawtab/shared";
import { ParamsOverlay } from "../../ParamsOverlay";
import { paneContentCacheKey, shouldCacheSinglePaneContent } from "../utils";
import type { useViewingState } from "../hooks/useViewingState";

interface DetailPaneProps {
  showFolderRunner: boolean;
  currentContent: PaneContent | null;
  recentSinglePaneContents: PaneContent[];
  renderSinglePaneContent: (content: PaneContent) => ReactNode;
  folderRunnerPane: ReactNode;
  viewing: ReturnType<typeof useViewingState>;
  handleRunWithParams: () => void;
}

export function DetailPane({
  showFolderRunner,
  currentContent,
  recentSinglePaneContents,
  renderSinglePaneContent,
  folderRunnerPane,
  viewing,
  handleRunWithParams,
}: DetailPaneProps) {
  const { paramsDialog, setParamsDialog } = viewing;

  if (showFolderRunner || !currentContent) return <>{folderRunnerPane}</>;

  return (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      {shouldCacheSinglePaneContent(currentContent) ? (
        recentSinglePaneContents.map((content) => {
          const key = paneContentCacheKey(content);
          const isActive = paneContentCacheKey(currentContent) === key;
          return (
            <div
              key={key}
              style={{
                display: isActive ? "flex" : "none",
                flexDirection: "column",
                position: "absolute",
                inset: 0,
                overflow: "hidden",
              }}
            >
              {renderSinglePaneContent(content)}
            </div>
          );
        })
      ) : (
        <div
          key={paneContentCacheKey(currentContent)}
          style={{
            display: "flex",
            flexDirection: "column",
            position: "absolute",
            inset: 0,
            overflow: "hidden",
          }}
        >
          {renderSinglePaneContent(currentContent)}
        </div>
      )}
      {paramsDialog && currentContent.kind === "job" && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}
    </div>
  );
}
