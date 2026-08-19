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
    port: 5173,
    host: true,
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
    // 代理配置，用于开发环境
    proxy: {
      "/api": {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  // `vite preview` 用生产构建产物(dist)本地起服务，是最接近 release 镜像的环境：
  // 同样的压缩 / 拆包 / CSS 加载顺序，可提前暴露只在生产构建出现的问题
  // （如主题变量被打包顺序覆盖）。用法：npm run build && npm run preview
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
