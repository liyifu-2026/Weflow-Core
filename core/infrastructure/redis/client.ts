/**
 * Redis 客户端
 * 使用 ioredis 提供 Redis 连接，支持延迟连接和健康检查
 */
import { Redis } from "ioredis";
import type { Logger } from "pino";

/** Redis 客户端类型，包含连接实例、健康检查和关闭方法 */
export type RedisClient = {
  connection: Redis;
  check: () => Promise<void>;
  close: () => void;
};

/**
 * 创建 Redis 客户端实例
 * @param redisUrl - Redis 连接字符串
 * @param logger - 日志记录器
 * @returns 包含连接实例和生命周期方法的对象
 */
export function createRedis(redisUrl: string, logger: Logger): RedisClient {
  const connection = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  connection.on("error", (error) => {
    logger.warn({ err: error }, "Redis connection error");
  });

  return {
    connection,
    check: async () => {
      if (connection.status === "wait") {
        await connection.connect();
      }
      await connection.ping();
    },
    close: () => {
      if (connection.status !== "end") {
        connection.disconnect();
      }
    },
  };
}
