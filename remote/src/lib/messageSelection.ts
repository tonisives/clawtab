// Read the text already displayed, preserving the cached conversation on return.
export const messageSelectionScript = `(() => {
  const logs = document.querySelector("#surface .card .logs");
  const messages = [...document.querySelectorAll("#surface .card .message")];
  const text = logs?.textContent || messages.map(node => node.textContent).join("\\n\\n");
  logs?._cancelSelection?.();
  document.activeElement?.blur();
  window.ReactNativeWebView.postMessage(JSON.stringify({ nfn: { native: "selection_text", text } }));
})();true;`;
