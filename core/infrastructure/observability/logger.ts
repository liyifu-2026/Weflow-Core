/**
 * 日志记录器工厂
 * 使用 Pino 创建结构化日志记录器，支持：
 * - 敏感信息脱敏（password、token、authorization 等）
 * - ISO 时间戳
 * - 服务名称标识
 */
import pino, { type Logger } from "pino";
import type { RuntimeConfig } from "../config/config.js";

/**
 * 创建日志记录器
 * @param config - 包含日志级别的配置
 * @param processName - 进程/服务名称
 * @returns Pino 日志记录器实例
 */
export function createLogger(
  config: Pick<RuntimeConfig, "logLevel">,
  processName: string,
): Logger {
  return pino({
    base: {
      service: processName,
    },
    level: config.logLevel,
    redact: {
      paths: [
        "password",
        "*.password",
        "token",
        "*.token",
        "authorization",
        "*.authorization",
        "cookie",
        "*.cookie",
        "databaseUrl",
        "redisUrl",
      ],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
