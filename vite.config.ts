import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    {
      // lucide-static ships eot/ttf/svg/woff fallbacks (~7 MB); a modern webview only needs woff2.
      name: "lucide-woff2-only",
      enforce: "pre",
      transform(code, id) {
        if (!id.includes("lucide-static/font/lucide.css")) return;
        return code.replace(
          /@font-face\s*{[^}]*}/,
          '@font-face{font-family:"lucide";src:url("lucide.woff2") format("woff2");font-display:block}',
        );
      },
    },
  ],
  clearScreen: false,
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.indexOf("monaco-editor/esm") !== -1) return "monaco";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
