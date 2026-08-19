/**
 * 白名单 CORS 插件
 *
 * 仅对显式配置的 origin 放行跨域请求；未配置 CORS_ORIGINS 时完全不开放
 * （生产默认保持无 CORS 头）。用于 Expo web 调试预览等受控跨域场景。
 * 移动端 Bearer token 鉴权不经 cookie，无需 allow-credentials。
 */
import type { FastifyInstance } from "fastify";

export function registerCors(server: FastifyInstance, origins: string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowed.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });
  // 预检：API 请求携带 content-type/authorization 头会触发 OPTIONS
  server.options("/*", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) {
      return reply.code(204).send();
    }
    return reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
      .header("access-control-allow-headers", "content-type,authorization")
      .header("access-control-max-age", "86400")
      .code(204)
      .send();
  });
}
