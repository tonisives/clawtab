import { colors } from "@clawtab/shared";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character] ?? character);

export const terminalSelectionDocument = (value: string) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
html,body{margin:0;min-height:100%;background:${colors.bg};color:${colors.text}}
body{padding:12px 0;font:13px/18px Menlo,monospace;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
</style></head><body><pre>${escapeHtml(value)}</pre></body></html>`;

