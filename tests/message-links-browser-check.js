(async () => {
  const checks = [];
  const assert = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const fixture = window.fixture;
  const mobile = Boolean(window.nfnMobile);
  const snapshot = () => ({ ...fixture.snapshot(), remote: mobile });
  fixture.records.clear();
  const record = fixture.record('deliverable-links');
  record.request.source = { provider: 'codex', pane_id: '%links', session_id: 'links-session' };
  record.request.body = 'The agent finished its turn and is ready for your next message.';
  record.request.actions = [{ id: 'focus', kind: 'focus', label: 'Open session' }, { id: 'acknowledge', kind: 'choice', label: 'Got it' }];
  record.request.data = { event: 'agent_finished', latest_agent_message: '[Web deployment](https://github.com/tgs-space/clawtab/actions/runs/42420259638)\n\nPreview: http://localhost:3000/preview.\n\nhttps://github.com/tgs-space/clawtab/actions/runs/42420259638' };
  fixture.records.set(record.id, record);
  window.nfn.receive(snapshot()); window.nfn.receive({ type: 'open_record', id: record.id });
  document.querySelector('.open-session').click();
  let links = [...document.querySelectorAll('.open-menu a')];
  assert(links.length === 2 && links[0].textContent === 'Web deployment', 'completion Open discovers labeled URLs and removes duplicates');
  assert(links[1].href === 'http://localhost:3000/preview', 'plain HTTP preview URL drops sentence punctuation');
  assert([...document.querySelectorAll('.open-menu button')].some(button => button.textContent === 'Agent'), 'Open keeps the originating agent available');
  const before = fixture.nativeEvents.length;
  links[0].click();
  assert(fixture.nativeEvents.slice(before).filter(event => event.native === 'external_link' && event.text === links[0].href).length === 1, 'deliverable selection opens the exact URL once through the platform bridge');
  assert(!document.querySelector('.open-menu'), 'deliverable selection closes the popup');
  record.request.data = {};
  record.request.body = '[Report](https://example.com/report)';
  window.nfn.receive(snapshot());
  document.querySelector('.open-session').click();
  links = [...document.querySelectorAll('.open-menu a')];
  assert(links.length === 1 && links[0].textContent === 'Report', 'ordinary message bodies also supply Open destinations');
  if (mobile) {
    document.querySelector('.open-menu .close').click();
    window.ReactNativeWebView = { postMessage() {} };
    window.nfn.receive({ ...snapshot(), native_chrome: true });
    window.nfn.receive({ type: 'mobile_action', action: 'open' });
    const panel = document.querySelector('.open-menu');
    assert(panel && document.querySelector('#surface').classList.contains('native-chrome'), 'native mobile Open action displays deliverables');
    const bounds = panel.getBoundingClientRect();
    assert(bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth, 'native mobile Open popup stays inside the viewport above its footer');
    const beforeNative = fixture.nativeEvents.length;
    panel.querySelector('a').click();
    assert(fixture.nativeEvents.slice(beforeNative).some(event => event.native === 'external_link' && event.text === 'https://example.com/report'), 'native mobile deliverables use the external link bridge');
  }
  return { passed: checks.length, checks };
})()
