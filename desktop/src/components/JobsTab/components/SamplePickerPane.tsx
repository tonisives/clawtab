import type { CSSProperties } from "react";
import { SamplePicker } from "../../SamplePicker";

interface SamplePickerPaneProps {
  headerMode: "back" | "close";
  onBlank: () => void;
  onCancel: () => void;
  onCreated: () => void;
  panelContentStyle: CSSProperties;
  pendingTemplateId?: string | null;
  pickerTemplateId: string | null;
}

export function SamplePickerPane({
  headerMode,
  onBlank,
  onCancel,
  onCreated,
  panelContentStyle,
  pendingTemplateId,
  pickerTemplateId,
}: SamplePickerPaneProps) {
  return (
    <div style={panelContentStyle}>
      <SamplePicker
        autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
        headerMode={headerMode}
        onCreated={onCreated}
        onBlank={onBlank}
        onCancel={onCancel}
      />
    </div>
  );
}
