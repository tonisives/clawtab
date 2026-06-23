import { View } from "react-native";

import { JobListScrollContent } from "./ScrollContent";
import type { JobListViewHook } from "./useJobListView";

interface JobListViewComponentProps {
  hook: JobListViewHook;
}

export function JobListViewComponent({ hook }: JobListViewComponentProps) {
  if (hook.renderAsScrollRoot) {
    return <JobListScrollContent hook={hook} />;
  }

  return (
    <View
      ref={hook.containerRef}
      style={hook.containerStyle}
      {...hook.containerWebProps}
    >
      <JobListScrollContent hook={hook} />
    </View>
  );
}
