(async () => {
  window.fixture.run();
  const start = Date.now();
  while (!window.fixture.checks && !window.fixture.error) {
    if (Date.now() - start > 60000) throw new Error("Mobile message checks timed out");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (window.fixture.error) throw new Error(window.fixture.error);
  const ranges = window.fixture.calls.filter(call => call.op === "media");
  if (!ranges.length || ranges.some(call => call.length > 256 * 1024 || call.machine !== "mac-a" && call.machine !== "mac-b")) {
    throw new Error("Media transfer used an unscoped or unbounded range");
  }
  return { passed: window.fixture.checks.length, checks: window.fixture.checks, media_ranges: ranges.length };
})()
