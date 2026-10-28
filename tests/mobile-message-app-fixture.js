// Injected only by serve-mobile-message-app.py into a worker-exported app.
(() => {
  const token = `fixture.${btoa(JSON.stringify({ exp: 4102444800, email: "fixture@example.test" }))}.fixture`;
  localStorage.setItem("clawtab_access_token", token);
  localStorage.setItem("clawtab_user_id", "message-ui-fixture");
  localStorage.setItem("clawtab_server_url", location.origin);
  const machines = ["mac-a", "mac-b"].map(id => ({
    id, name: id, online: true, owned: true, connection_id: id, platform: "macos",
    architecture: "arm64", version: "fixture", capabilities: [], last_seen: null,
  }));
  const record = (machine, body) => ({
    id: "launch-review", status: "pending", created_at: 1, updated_at: 1,
    read_at: null, dismissed_at: null, response: null, question_id: null, error: null,
    request: { title: "Review the launch post", template: "social-review", body,
      source: { provider: "codex", group: "ClawTab", agent_title: machine, pane_id: "%18" },
      response_destination: "result", data: { platform: "X" },
      media: [{ kind: "image", src: "/fixture/preview.png", alt: "ClawTab terminal and agent" },
        { kind: "video", src: "/fixture/preview.mp4", alt: "ClawTab remote demo" }],
      actions: [{ id: "post", kind: "choice", label: "Post to X" },
        { id: "revise", kind: "choice", label: "Request changes" }, { id: "reject", kind: "choice", label: "Reject" }],
    },
  });
  const records = { "mac-a": [record("mac-a", "Caption from Mac A")],
    "mac-b": [record("mac-b", "Your agents, wherever you are. Review the ClawTab launch post and its media.")] };
  const fixture = window.messageAppFixture = { calls: [], sockets: [], records };
  class FixtureSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    constructor(url) {
      this.url = url;
      fixture.sockets.push(this);
      setTimeout(() => {
        this.readyState = 1; this.onopen?.({});
        this.emit({ type: "machines", machines, connection_id: "message-ui-browser" });
        for (const machine of machines) this.snapshot(machine.id);
      }, 20);
    }
    emit(value) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }); }
    snapshot(machine) { this.emit({ type: "machine_event", machine_id: machine,
      message: { type: "messages_changed", records: records[machine] } }); }
    send(raw) {
      const value = JSON.parse(raw);
      if (value.type === "refresh_machines") {
        this.emit({ type: "machines", machines, connection_id: "message-ui-browser" }); return;
      }
      const { machine_id: machine, request_id, message } = value;
      if (!message) return;
      fixture.calls.push({ machine, ...message });
      const reply = response => setTimeout(() => this.emit({ type: "machine_event", machine_id: machine, request_id, message: response }), 1);
      if (message.type === "list_jobs") return reply({ type: "jobs_list", jobs: [], statuses: {} });
      if (message.type === "detect_processes") return reply({ type: "detected_processes", processes: [] });
      if (message.type === "get_settings") return reply({ type: "settings_response", enabled_models: {}, default_provider: "codex" });
      if (message.type !== "host_request") return reply({ type: "sent" });
      const command = message.request.command;
      void (async () => {
        let result;
        const item = records[machine]?.find(record => record.id === command.id);
        if (command.op === "list") result = { records: records[machine].slice(command.offset || 0, (command.offset || 0) + 50) };
        else if (command.op === "get" || command.op === "read") {
          if (!item) throw new Error("Message not found");
          if (command.op === "read") item.read_at = Date.now();
          result = item;
        } else if (command.op === "templates") result = { templates: [{ id: "social-review", layout: [
          { type: "text", field: "body" }, { type: "media" }, { type: "choices" }, { type: "reply" }, { type: "logs" },
        ] }] };
        else if (command.op === "todos") result = { items: [] };
        else if (command.op === "context") result = { source: item.request.source, log: "Draft and attachments ready for review", models: [], plugins: [] };
        else if (command.op === "media") result = await fetch(`/__message_fixture/media/${command.index}?offset=${command.offset}&length=${command.length}`).then(response => response.json());
        else throw new Error("Fixture keeps decisions pending");
        reply({ type: "host_response", result });
      })().catch(error => reply({ type: "error", error: error.message }));
    }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({})); }
  }
  window.WebSocket = FixtureSocket;
  fixture.arrive = (machine, id, body, template = "update") => {
    const next = record(machine, body); next.id = id; next.created_at = Date.now();
    next.request.template = template; next.request.media = []; next.request.actions = [];
    records[machine].unshift(next);
    for (const socket of fixture.sockets) socket.snapshot(machine);
  };
})();
