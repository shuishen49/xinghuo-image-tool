import { defineConfig } from "vite";

// Tauri expects the dev server on a fixed port (1420) so the Rust side can find it.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // don't reload the frontend when Rust files change
      ignored: ["**/src-tauri/**"],
    },
  },
});
