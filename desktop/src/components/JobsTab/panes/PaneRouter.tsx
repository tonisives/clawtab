import type { PaneContent } from "@clawtab/shared";
import { AgentPane } from "./AgentPane";
import { ProcessPane } from "./ProcessPane";
import { TerminalPane } from "./TerminalPane";
import { JobPane } from "./JobPane";
import type { PaneContext } from "./paneTypes";

export function PaneRouter({ content, ctx }: { content: PaneContent; ctx: PaneContext }) {
  switch (content.kind) {
    case "agent":    return <AgentPane content={content} ctx={ctx} />;
    case "process":  return <ProcessPane content={content} ctx={ctx} />;
    case "terminal": return <TerminalPane content={content} ctx={ctx} />;
    case "job":      return <JobPane content={content} ctx={ctx} />;
  }
}
