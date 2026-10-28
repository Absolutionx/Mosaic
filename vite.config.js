import { defineConfig } from "vite";
import { resolve } from "path";

// `tauri android dev` sets TAURI_DEV_HOST to this PC's address on the network, so the phone can reach the
// dev server; desktop leaves it unset and keeps localhost
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
  },
  build: {
    rollupOptions: {
      // Two pages: the app itself, and the native always-on-top PiP
      // window (see pip.html / enterNativePip in playback-controls.js).
      input: {
        main: resolve(__dirname, "index.html"),
        pip: resolve(__dirname, "pip.html"),
      },
    },
  },
});
