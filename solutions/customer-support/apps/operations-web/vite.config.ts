import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const CORE_API_TARGET = process.env.CORE_API_TARGET || "http://127.0.0.1:3100";

export default defineConfig({
  base: "/support/",
  plugins: [vue(), cssInjectedByJsPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/entry.ts", import.meta.url)),
      name: "WeflowOperationsConsole",
      formats: ["es"],
      fileName: () => "operations-console.js",
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
  server: {
    port: 5175,
    host: true,
    cors: true,
    proxy: {
      "/api": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4175,
    host: true,
    proxy: {
      "/api": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
