/**
 * 进程运行时框架
 * 提供统一的进程启动、健康检查和优雅关闭逻辑
 * 支持三种进程类型：core-api、agent-worker、ingestion-worker
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { loadConfig, type RuntimeConfig } from "../config/config.js";
import { startHealthServer } from "../health/server.js";
import { createLogger } from "../observability/logger.js";
import { createPostgres } from "../postgres/client.js";
import { createRedis } from "../redis/client.js";
import type { Postgres } from "../postgres/client.js";

/** 进程定义类型 */
type ProcessDefinition = {
  name: "core-api" | "agent-worker" | "ingestion-worker";
  healthPort: (config: RuntimeConfig) => number;
  configureServer?: (
    server: FastifyInstance,
    context: {
      config: RuntimeConfig;
      logger: Logger;
      postgres: Postgres;
    },
  ) => void | Promise<void>;
  start?: (context: {
    config: RuntimeConfig;
    logger: Logger;
    postgres: Postgres;
  }) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
};

/**
 * 运行进程
 * @param definition - 进程定义（名称、健康检查端口、配置和启动逻辑）
 */
export async function runProcess(definition: ProcessDefinition): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, definition.name);
  const postgres = createPostgres(config.databaseUrl, logger);
  const redis = createRedis(config.redisUrl, logger);
  let healthServer: FastifyInstance | undefined;
  let stopping = false;
  let stopApplication: (() => void | Promise<void>) | undefined;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await stopApplication?.();
    await healthServer?.close();
    await postgres.close();
    redis.close();
  };

  try {
    healthServer = await startHealthServer({
      processName: definition.name,
      host: config.healthHost,
      port: definition.healthPort(config),
      dependencies: [
        { name: "postgres", check: postgres.check },
        { name: "redis", check: redis.check },
      ],
      configure: (server) =>
        definition.configureServer?.(server, {
          config,
          logger,
          postgres,
        }),
    });
    stopApplication = await definition.start?.({
      config,
      logger,
      postgres,
    });

    logger.info(
      {
        host: config.healthHost,
        port: definition.healthPort(config),
      },
      "process ready for health checks",
    );

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void stop(signal).then(() => {
          process.exitCode = 0;
        });
      });
    }
  } catch (error) {
    reportStartupFailure(logger, error);
    await stop("startup_failure");
    throw error;
  }
}

function reportStartupFailure(logger: Logger, error: unknown): void {
  logger.fatal({ err: error }, "process startup failed");
}
