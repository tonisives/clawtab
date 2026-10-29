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
  messages.forEach(([group, name, body, minutes], index) => {
    const record = window.fixture.record(`preview-${index}`);
    record.request.source = { group, agent_title: name, pane_id: `%${index}` };
    record.request.body = body; record.created_at = Date.now() - minutes * 60000;
    window.fixture.records.set(record.id, record);
  });
  window.nfn.setPlacement({ placement: "right", reduce_motion: true });
  window.nfn.receive(window.fixture.snapshot("preview-0"));
  document.hasFocus = () => true;
  if (view === "list") {
    document.querySelector('[aria-label="Notification list"]').click();
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  } else {
    document.querySelector('[aria-label="Notification settings"]').click();
    [...document.querySelectorAll("[data-settings-tab]")].find(tab => tab.dataset.settingsTab === view).click();
  }
  await sleep(150);
  return { preview: view };
}
