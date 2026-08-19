/**
 * 健康检查服务器
 * 提供 HTTP 健康检查端点，用于容器编排和负载均衡
 * - /health/live: 存活探针（进程是否运行）
 * - /health/ready: 就绪探针（依赖服务是否可用）
 */
import Fastify, { type FastifyInstance } from "fastify";

/** 依赖检查类型 */
export type DependencyCheck = {
  name: string;
  check: () => Promise<void>;
};

type HealthServerOptions = {
  processName: string;
  host: string;
  port: number;
  dependencies: DependencyCheck[];
  configure?: (server: FastifyInstance) => void | Promise<void>;
};

/**
 * 启动健康检查服务器
 * @param options - 服务器配置
 * @returns Fastify 服务器实例
 */
export async function startHealthServer(
  options: HealthServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
  });

  server.get("/health/live", () => ({
    process: options.processName,
    status: "ok",
  }));

  server.get("/health/ready", async (_request, reply) => {
    const results = await Promise.allSettled(
      options.dependencies.map(async (dependency) => {
        await dependency.check();
        return dependency.name;
      }),
    );
    const failed = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              name: options.dependencies[index]?.name ?? "unknown",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : "dependency check failed",
            },
          ]
        : [],
    );

    if (failed.length > 0) {
      return reply.code(503).send({
        process: options.processName,
        status: "not_ready",
        failed,
      });
    }

    return {
      process: options.processName,
      status: "ready",
    };
  });

  await options.configure?.(server);

  await server.listen({
    host: options.host,
    port: options.port,
  });
  return server;
}
