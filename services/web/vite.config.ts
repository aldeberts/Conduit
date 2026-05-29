import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://127.0.0.1:3333", changeOrigin: true, ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/@codemirror/") ||
            id.includes("node_modules/@lezer/") ||
            id.includes("node_modules/@uiw/")
          ) {
            return "codemirror";
          }
        },
      },
    },
  },
});
