// Put the initial view in the local document so its first paint does not wait
// for a WebView/iframe ready message to make a round trip through React.
export function messageSurfaceInitialDocument(document: string, props: {
  snapshot: Record<string, unknown>;
  selection?: string | null;
  popup?: boolean;
  active?: boolean;
}) {
  if (props.active === false) return document;
  const values: unknown[] = [props.snapshot, props.selection
    ? { type: "open_record", id: props.selection, popup: props.popup }
    : { type: "show" }];
  const json = JSON.stringify(values).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return document.replace("</body>", `<script>for(const value of ${json})window.nfn.receive(value);</script></body>`);
}
