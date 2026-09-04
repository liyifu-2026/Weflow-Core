/**
 * 产品网页端静态托管（R4 部署形态）。
 *
 * 生产部署不再依赖 Vite dev server：api 进程直接托管 support-web 的
 * 构建产物（WEB_DIST_DIR 指向 support-web/dist）。SPA 使用 browser
 * history 真实路径，因此除 /api、/health、/customer-support 等已注册
 * 前缀外的 GET 请求一律回落 index.html。
 *
 * WEB_DIST_DIR 未配置或目录不存在时不注册（开发态走 Vite dev server）。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** 已被业务/平台路由占用的前缀：这些路径不参与 SPA fallback */
const RESERVED_PREFIXES = ["/api/", "/health", "/customer-support/"];

/** 解析前端产物目录：未配置或不存在返回 undefined */
export function resolveWebDistDir(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const dir = join(value);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  if (!existsSync(join(dir, "index.html"))) return undefined;
  return dir;
}

/** 是否应回落到 SPA index.html（非保留前缀的 GET 导航请求） */
export function shouldFallbackToSpa(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const path = url.split("?")[0] ?? "/";
  return !RESERVED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** 注册静态托管；webDistDir 为 undefined 时静默跳过（返回 false） */
export async function registerWebStatic(
  server: FastifyInstance,
  webDistDir: string | undefined,
): Promise<boolean> {
  if (!webDistDir) return false;
  await server.register(fastifyStatic, {
    root: webDistDir,
    prefix: "/",
    wildcard: false,
    index: false,
    // send 库默认会输出 `Cache-Control: public, max-age=0` 并覆盖 setHeaders
    // 的结果，必须关闭后由 setHeaders 全权控制缓存策略
    cacheControl: false,
    // 注意：setHeaders 的第二个参数是文件系统绝对路径（Windows 为反斜杠），
    // 需要先裁成相对 URL 路径再判断
    setHeaders(res, filePath) {
      const relative = filePath
        .slice(webDistDir.length)
        .replace(/\\/g, "/");
      // 带 hash 的产物长缓存；index.html / SPA fallback 不缓存保证发版即时生效
      if (relative.startsWith("/assets/")) {
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("cache-control", "no-cache");
      }
    },
  });
  server.setNotFoundHandler((request, reply) => {
    if (!shouldFallbackToSpa(request.method, request.url)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    void reply.sendFile("index.html");
  });
  return true;
}
