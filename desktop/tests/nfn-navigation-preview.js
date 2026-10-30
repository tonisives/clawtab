async view => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  window.nfn.collapse(); window.fixture.records.clear();
  const messages = [
    ["clawtab", "Message bar", "Keyboard navigation is ready for review", 2],
    ["bmux", "Sessions", "Session picker search now keeps its query", 12],
    ["clawtab", "Release", "Desktop build completed", 34],
    ["notes", "Inbox", "Three research notes need your review", 65],
    ["clawtab", "Mobile", "The latest device check passed", 120],
    ["bmux", "Search", "Search results include archived sessions", 1440],
  ];
  const entries = view === "actions" ? messages.slice(0, 1) : view === "long-list" ? Array.from({ length: 24 }, (_, index) => messages[index % messages.length]) : messages;
  entries.forEach(([group, name, body, minutes], index) => {
    const record = window.fixture.record(`preview-${index}`);
    record.request.source = { group, agent_title: name, pane_id: `%${index}` };
    record.request.body = body; record.created_at = Date.now() - minutes * 60000;
    if (view === "actions") { record.request.template = "update"; record.request.actions = [{ id: "acknowledge", label: "Got it", kind: "choice" }]; }
    window.fixture.records.set(record.id, record);
  });
  window.nfn.setPlacement({ placement: "right", reduce_motion: true });
  window.fixture.settings.keyboard_hints = true;
  window.nfn.receive(window.fixture.snapshot("preview-0"));
  document.hasFocus = () => view !== "passive";
  if (["list", "long-list", "selection"].includes(view)) {
    document.querySelector('[aria-label="Notification list"]').click();
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    if (view === "selection") document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
  } else if (view !== "actions") {
    document.querySelector('[aria-label="Notification settings"]').click();
    [...document.querySelectorAll("[data-settings-tab]")].find(tab => tab.dataset.settingsTab === (["active", "passive"].includes(view) ? "appearance" : view)).click();
  }
  if (view === "active") window.nfn.receive({ type: "keyboard_focus", active: true });
  window.dispatchEvent(new Event(view === "passive" ? "blur" : "focus"));
  await sleep(150);
  return { preview: view };
}
