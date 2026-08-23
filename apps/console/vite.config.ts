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

function pluginStaticServe() {
  return {
    name: "weflow-plugin-static-serve",
    configureServer(server: any) {
      server.middlewares.use("/plugins/", (req: any, res: any, next: any) => {
        try {
          const url = (req.url || "").split("?")[0];
          const segments = url.replace(/^\/+/, "").split("/").filter(Boolean);
          if (segments.length < 2) return next();
          const safe = segments.map((s: string) =>
            s.replace(/[^a-zA-Z0-9._-]/g, ""),
          );
          const filePath = resolve(PLUGIN_STATIC_ROOT, ...safe);
          if (!filePath.startsWith(resolve(PLUGIN_STATIC_ROOT))) return next();
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            res.statusCode = 200;
            res.setHeader(
              "Content-Type",
              extname(filePath) === ".js" ? "text/javascript" : "application/octet-stream",
            );
            createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/console/",
  define: {
    __FRONTEND_VERSION__: JSON.stringify(FRONTEND_VERSION),
    __FRONTEND_COMMIT__: JSON.stringify(FRONTEND_COMMIT),
  },
  plugins: [vue(), pluginStaticServe()],
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