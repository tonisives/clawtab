import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;
const portlessAllowedHosts = (process.env.PORTLESS_TLD ?? "")
  .split(",")
  .map((tld) => tld.trim().replace(/^\./, ""))
  .filter(Boolean)
  .map((tld) => `.${tld}`);

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      "react-native": "react-native-web",
      "@clawtab/shared": resolve(__dirname, "../shared/src"),
    },
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
  },
  build: {
    rollupOptions: {
      input: {
        settings: resolve(__dirname, "settings.html"),
        debug: resolve(__dirname, "debug.html"),
        pty_debug: resolve(__dirname, "pty_debug.html"),
        tmux_debug: resolve(__dirname, "tmux_debug.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    allowedHosts: [".localhost", ...portlessAllowedHosts],
    port: 1427,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1427 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
