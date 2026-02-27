import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

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
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1427,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1427 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
