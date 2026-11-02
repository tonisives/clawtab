import { machineHostRequest, splitResource } from "@clawtab/shared";

// The same capture and literal input operations used by notification shells.
// Opening this view never attaches a PTY or changes the host terminal's size.
export function capturedShellCommand(paneId: string) {
  return async (command: Record<string, unknown>) => {
    if (command.op === "read") return {};
    const resource = splitResource(paneId);
    if (!resource) throw new Error("This shell's machine is missing");
    if (command.op === "context" || command.op === "shell_input") {
      return machineHostRequest(resource.machine, { action: "message", command: {
        op: command.op === "context" ? "pane_context" : "pane_input",
        pane_id: resource.id,
        ...(command.op === "shell_input" ? { text: String(command.text ?? "") } : {}),
      } });
    }
    throw new Error("Unsupported shell operation");
  };
}

export function capturedShellSnapshot(paneId: string, visible: boolean) {
  return {
    type: "snapshot", remote: true, native_chrome: true, shell_only: true, visible,
    pending_count: 1,
    records: [{ id: paneId, status: "pending", created_at: 0, updated_at: 0,
      request: { title: "Shell", body: "", template: "shell", actions: [], source: { pane_id: paneId } } }],
    templates: { templates: [{ id: "shell", layout: [{ type: "logs" }] }] },
    settings: { hover_expand: false, placement: "right" },
  };
}
