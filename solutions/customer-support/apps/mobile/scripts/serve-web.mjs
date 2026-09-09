/** 极简 SPA 静态服务：Expo web export 产物 + 路由 fallback（/conversation/:id → [id].html） */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = 19006;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    // 路由 fallback：/conversation/:id → conversation/[id].html（Expo Router 动态路由文件）
    let file = join(ROOT, path === "/" ? "index.html" : path);
    if (!file.endsWith(".html")) {
      const staticFile = join(ROOT, path);
      try {
        await readFile(staticFile);
        file = staticFile;
      } catch {
        file = join(ROOT, path + ".html");
        try {
          await readFile(file);
        } catch {
          if (/^\/conversation\//.test(path)) {
            file = join(ROOT, "conversation", "[id].html");
          } else {
            file = join(ROOT, "index.html");
          }
        }
      }
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on :${PORT}`));
