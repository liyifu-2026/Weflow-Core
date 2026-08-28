import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
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

const PLUGIN_STATIC_ROOT = fileURLToPath(
  new URL("../../../weflow-solutions/solutions", import.meta.url),
);

/**
 * solutionId → 磁盘目录名 映射（本地开发）。
 * Solution Pack 的 metadata.id 是 weflow.customer-support，而工作区目录
 * 是 customer-support；store 解包目录则按 id 命名。生产走 store（见
 * docs/solution-assets.md），dev 用此映射落到工作区源码目录。
 */
const SOLUTION_ID_DIR: Record<string, string> = {
  "weflow.customer-support": "customer-support",
  "weflow.weknora-connector": "weknora-connector",
};

// Solution Pack 解包目录（本地开发）。可用 SOLUTION_ASSETS_ROOT 覆盖
// （绝对路径，或相对 apps/console 的路径）。
function resolveSolutionAssetsRoot(): string {
  const fromEnv = process.env.SOLUTION_ASSETS_ROOT;
  if (fromEnv) return resolve(fileURLToPath(new URL(".", import.meta.url)), fromEnv);
  return PLUGIN_STATIC_ROOT;
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * 本地开发代理：把 Solution 静态资源请求直接映射到解包目录
 *   /plugins/<solutionId>/<...path>          → <root>/<solutionId>/<...path>
 *   /solution-assets/<solutionId>/<...path>  → <root>/<solutionId>/<...path>
 * 例如 entry `/plugins/customer-support/apps/support-web/dist/support-console.js`
 * 在本地映射到 weflow-solutions/solutions/customer-support/apps/support-web/dist/。
 *
 * 生产形态不经过本中间件：由 web 服务器把这两个前缀托管到解包目录
 * （见 apps/console/docs/solution-assets.md）。
 */
function solutionAssetsServe() {
  function handle(req: any, res: any, next: any) {
    try {
      const url = (req.url || "").split("?")[0];
      const segments = url.replace(/^\/+/, "").split("/").filter(Boolean);
      if (segments.length < 1) return next();
      // 首段是 solutionId：映射到工作区目录名（如 weflow.customer-support → customer-support）
      const mapped = segments.map((segment: string, index: number) =>
        index === 0 ? (SOLUTION_ID_DIR[segment] ?? segment) : segment,
      );
      const safe = mapped.map((s: string) =>
        s.replace(/[^a-zA-Z0-9._-]/g, ""),
      );
      const root = resolveSolutionAssetsRoot();
      const filePath = resolve(root, ...safe);
      if (!filePath.startsWith(resolve(root))) return next();
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        res.statusCode = 200;
        res.setHeader(
          "Content-Type",
          STATIC_MIME_TYPES[extname(filePath).toLowerCase()] ??
            "application/octet-stream",
        );
        createReadStream(filePath).pipe(res);
      } else {
        next();
      }
    } catch {
      next();
    }
  }
  return {
    name: "weflow-solution-assets-serve",
    configureServer(server: any) {
      server.middlewares.use("/plugins/", handle);
      server.middlewares.use("/solution-assets/", handle);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use("/plugins/", handle);
      server.middlewares.use("/solution-assets/", handle);
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/console/",
  define: {
    __FRONTEND_VERSION__: JSON.stringify(FRONTEND_VERSION),
    __FRONTEND_COMMIT__: JSON.stringify(FRONTEND_COMMIT),
  },
  plugins: [vue(), solutionAssetsServe()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@docs": fileURLToPath(new URL("../../docs", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: ["web.leaif.com", "api.leaif.com", "leaif.com", "localhost", "127.0.0.1"],
    fs: {
      allow: [
        fileURLToPath(new URL("../..", import.meta.url)),
        PLUGIN_STATIC_ROOT,
      ],
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