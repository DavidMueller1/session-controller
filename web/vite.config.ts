import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// dev:live points this at its own backend port (running alongside the installed app on
// :4317) via TC_API, so both can serve the same shared DB at once.
const API = process.env.TC_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/ws": { target: API, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
