import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const require = createRequire(import.meta.url);

const pkg = require("./package.json") as { version?: string };
const FRONTEND_VERSION = pkg.version ?? "unknown";

function resolveFrontendCommit(): string {
  const fromEnv = process.env.VITE_FRONTEND_COMMIT || process.env.GITHUB_SHA;
  if (fromEnv) {
    return fromEnv.slice(0, 7);
  }
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const FRONTEND_COMMIT = resolveFrontendCommit();

const DEV_PROXY_TARGET =
  process.env.VITE_DEV_PROXY_TARGET ||
  process.env.FRONTEND_BACKEND_URL ||
  "http://localhost:3100";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/console/",
  define: {
    __FRONTEND_VERSION__: JSON.stringify(FRONTEND_VERSION),
    __FRONTEND_COMMIT__: JSON.stringify(FRONTEND_COMMIT),
  },
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@docs": fileURLToPath(new URL("../../docs", import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.VITE_CONSOLE_PORT) || 5173,
    host: true,
    allowedHosts: ["web.leaif.com", "api.leaif.com", "leaif.com", "localhost", "127.0.0.1"],
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
    proxy: {
      "/api": {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4173,
    host: true,
    allowedHosts: ["web.leaif.com", "localhost"],
    proxy: {
      "/api": {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
