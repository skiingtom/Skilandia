import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so dist/ works when the desktop app opens it from disk.
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: false,
    watch: { ignored: ["**"] },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
