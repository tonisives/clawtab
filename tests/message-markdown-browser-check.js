(async () => {
  const checks = [];
  const assert = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const message = document.createElement('div'); document.body.append(message);
  const opened = [];
  window.nfnMarkdown(message, '# Review recordings\n\nOpen **Plugins** and *Recordings*.\nNext line.\n\n- Check `search`\n- Read replies\n  - Compare counts\n\n3. Open dashboard\n4. Review results\n\n[Collection dashboard](https://example.com/dashboard?a=1&b=2) and https://example.com/raw\n\n```sh\ncwt message list --pending\n```\n\n> Compare retained counts.\n\n| Check | Result |\n| --- | --- |\n| Search | Ready |\n\n- [x] Reviewed\n\n~~Old~~ &amp; new', href => opened.push(href));
  assert(message.querySelector('h1')?.textContent === 'Review recordings', 'headings render');
  assert(message.querySelector('strong')?.textContent === 'Plugins' && message.querySelector('em')?.textContent === 'Recordings', 'inline emphasis renders');
  assert(message.querySelector('p br'), 'plain newlines remain visible');
  assert(message.querySelector('ul ul li')?.textContent === 'Compare counts' && message.querySelector('ol')?.start === 3, 'nested and ordered lists render');
  assert(message.querySelector('pre code')?.textContent.includes('cwt message list --pending'), 'fenced code stays literal');
  assert(message.querySelector('blockquote') && message.querySelector('table td')?.textContent === 'Search', 'quotes and tables render');
  assert(message.querySelector('input')?.disabled && message.querySelector('input')?.checked, 'task lists are read only');
  assert(message.querySelector('del')?.textContent === 'Old' && message.textContent.includes('& new'), 'strikethrough and entities render');
  const link = message.querySelector('a'); link.click();
  assert(opened[0] === 'https://example.com/dashboard?a=1&b=2', 'labeled links route the exact URL through the host');
  assert(message.querySelectorAll('a[href]').length === 2, 'bare URLs become clickable');
  window.nfnMarkdown(message, '<img src=x onerror="window.markdownInjected=1">\n\n<script>window.markdownInjected=1</script>\n\n[bad](javascript:alert(1)) [data](data:text/html,test) [file](file:///tmp/test) ![preview](https://example.com/tracker.png)\n\n`<b>literal</b>`', href => opened.push(href));
  assert(!message.querySelector('script,img,iframe,object,style') && !window.markdownInjected, 'raw HTML and images cannot execute or load resources');
  assert(!message.querySelector('a[href]'), 'script, data, and file links are inert');
  assert(message.textContent.includes('<img') && message.querySelector('code')?.textContent === '<b>literal</b>', 'HTML and code are displayed as text');
  window.nfnMarkdown(message, 'Plain message\nwith a path /Volumes/sam/movies/\n\nand another paragraph.', () => {});
  assert(message.querySelectorAll('p').length === 2 && message.querySelector('br'), 'existing plain messages preserve paragraphs and newlines');
  message.remove();
  if (window.fixture) {
    const fixture = window.fixture; fixture.records.clear();
    const first = fixture.record("markdown-first"), latest = fixture.record("markdown-latest");
    latest.created_at = first.created_at + 1;
    for (const record of [first, latest]) {
      record.request.source = { session_id: "markdown-session", pane_id: "%markdown", provider: "codex" };
      record.request.body = "**Review** the [dashboard](https://example.com/review).";
      fixture.records.set(record.id, record);
    }
    window.nfn.receive(fixture.snapshot()); window.nfn.receive({ type: "open_record", id: latest.id });
    assert(document.querySelectorAll(".message-thread .message.markdown strong").length === 2, "grouped agent messages render Markdown in every entry");
    document.querySelector(".message-thread .message a").click();
    assert(fixture.nativeEvents.some(event => event.native === "external_link" && event.text === "https://example.com/review"), "card links use the external link bridge");
  }
  return { passed: checks.length, checks };
})()
