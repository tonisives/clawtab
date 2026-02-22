import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { SettingsApp } from "./components/SettingsApp";
import "./settings.css";

// Capture console output to /tmp/clawtab/editor.log
(() => {
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0);
    invoke("write_editor_log", { lines }).catch(() => {});
    timer = null;
  }

  function capture(level: string, original: (...args: unknown[]) => void) {
    return (...args: unknown[]) => {
      original.apply(console, args);
      const msg = `[${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
      buffer.push(msg);
      if (!timer) timer = setTimeout(flush, 200);
    };
  }

  console.log = capture("LOG", console.log);
  console.warn = capture("WARN", console.warn);
  console.error = capture("ERROR", console.error);
  console.info = capture("INFO", console.info);

  window.addEventListener("error", (e) => {
    buffer.push(`[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}`);
    if (!timer) timer = setTimeout(flush, 200);
  });
})();

// Truncate editor.log on startup
invoke("write_editor_log", { lines: ["--- editor session start ---"] }).catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
