/**
 * 应用配置加载器
 * 从环境变量和 Secret 文件加载运行时配置，包括：
 * - 服务器端口和健康检查
 * - 数据库和 Redis 连接
 * - Channel Host 配置
 * - 模型 API 配置（DeepSeek）
 * - 视觉模型配置（MiMo）
 * - WeKnora 知识库配置
 * 敏感信息支持从文件读取（*_FILE 环境变量）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65_535);
const workerConcurrency = z.coerce.number().int().min(1).max(20);

/** 环境变量 Schema 定义 */
const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
  CORE_PORT: port.default(3100),
  AGENT_WORKER_HEALTH_PORT: port.default(3101),
  AGENT_WORKER_CONCURRENCY: workerConcurrency.default(3),
  MEMORY_CAPTURE_CONCURRENCY: workerConcurrency.max(5).default(1),
  /** 媒体处理（视觉描述/语音转写）并发；默认 1 避免多模态模型过载，高并发场景可上调 */
  MEDIA_PROCESSING_CONCURRENCY: workerConcurrency.default(1),
  INGESTION_WORKER_HEALTH_PORT: port.default(3102),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  FILE_STORAGE_ROOT: z.string().min(1).default(".data/files"),
  CHANNEL_HOST_BASE_URL: z.url().optional(),
  CHANNEL_HOST_TOKEN: z.string().min(1).optional(),
  CHANNEL_HOST_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(1000),
  /** 头像代理：上游拉取超时与进程内缓存 TTL */
  AVATAR_PROXY_TIMEOUT_MS: z.coerce.number().int().min(500).default(5_000),
  AVATAR_CACHE_TTL_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  /** 头像代理允许拉取的域名后缀白名单（逗号分隔；不配置 = 全部拒绝） */
  AVATAR_ALLOWED_HOSTS: z.string().trim().optional(),
  MODEL_BASE_URL: z.url().default("https://api.deepseek.com"),
  MODEL_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z
    .enum(["deepseek-v4-flash", "deepseek-v4-pro"])
    .default("deepseek-v4-flash"),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  VISION_BASE_URL: z.url().default("https://token-plan-cn.xiaomimimo.com/v1"),
  VISION_API_KEY: z.string().min(1).optional(),
  VISION_MODEL: z.literal("mimo-v2.5").default("mimo-v2.5"),
  VISION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** 语音转写模型（复用视觉端点与密钥；实测端点不支持音频时可覆盖为 mimo-v2.5-asr） */
  ASR_MODEL: z.string().min(1).default("mimo-v2.5"),
  /** 专用 ASR 端点（OpenAI 兼容 audio/transcriptions，如硅基流动）；配置后优先于视觉端点 */
  ASR_BASE_URL: z.url().optional(),
  ASR_API_KEY: z.string().min(1).optional(),
  ASR_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** 预判分流模型（极速小模型）：Agent Turn 进入主决策前做人工/自动、简单/标准分流判定 */
  TRIAGE_BASE_URL: z.url().default("https://api.siliconflow.cn/v1"),
  TRIAGE_MODEL: z.string().min(1).default("Qwen/Qwen2.5-7B-Instruct"),
  TRIAGE_API_KEY: z.string().min(1).optional(),
  TRIAGE_TIMEOUT_MS: z.coerce.number().int().min(500).default(3_000),
  /** 直答模型：分流判定为 simple 且运营开启直答时用于生成客户回复 */
  FAST_BASE_URL: z.url().default("https://api.siliconflow.cn/v1"),
  FAST_MODEL: z.string().min(1).default("THUDM/GLM-4-9B-0414"),
  FAST_API_KEY: z.string().min(1).optional(),
  FAST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  WEKNORA_BASE_URL: z.url().default("http://localhost/api/v1"),
  WEKNORA_API_KEY: z.string().min(1).optional(),
  WEKNORA_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  WEKNORA_KNOWLEDGE_BASE_IDS: z.string().trim().optional(),
  /**
   * WeKnora 站点 origin（不带 /api/v1），用于把浏览器 302 到 WeKnora UI 进行代管登录。
   * 未配置时回退到 WEKNORA_BASE_URL 去掉 /api/v1 后缀；两值都不可用时桥接仍可工作
   * （launch / exchange 不依赖 origin），仅 /knora/redirect 会返回 503。
   */
  WEKNORA_ORIGIN: z.url().optional(),
  /** CORS 白名单（逗号分隔的完整 origin）；不配置则完全不开放跨域 */
  CORS_ORIGINS: z.string().trim().optional(),
  /** WeKnora 桥接：账号凭证加密密钥（缺失时桥接路由返回 503） */
  KNORA_ACCOUNT_ENC_KEY: z.string().min(8).optional(),
  /** WeKnora 桥接：weflow 用户归入的租户（成员管理与激活租户） */
  KNORA_TENANT_ID: z.coerce.number().int().positive().default(10000),
  /** WeKnora 桥接：weflow 用户名合成的邮箱域（<username>@<domain>） */
  KNORA_ACCOUNT_EMAIL_DOMAIN: z.string().min(1).default("weflow.com"),
});

/** 运行时配置类型定义 */
export type RuntimeConfig = {
  nodeEnv: z.infer<typeof environmentSchema>["NODE_ENV"];
  logLevel: z.infer<typeof environmentSchema>["LOG_LEVEL"];
  healthHost: string;
  corePort: number;
  agentWorkerHealthPort: number;
  agentWorkerConcurrency: number;
  memoryCaptureConcurrency: number;
  mediaProcessingConcurrency: number;
  ingestionWorkerHealthPort: number;
  databaseUrl: string;
  redisUrl: string;
  fileStorageRoot: string;
  channelHost:
    | {
        baseUrl: string;
        token: string;
        pollIntervalMs: number;
      }
    | undefined;
  avatar: {
    proxyTimeoutMs: number;
    cacheTtlMs: number;
    allowedHosts: string[];
  };
  model:
    | {
        baseUrl: string;
        apiKey: string;
        name: "deepseek-v4-flash" | "deepseek-v4-pro";
        timeoutMs: number;
      }
    | undefined;
  vision:
    | {
        baseUrl: string;
        apiKey: string;
        name: "mimo-v2.5";
        timeoutMs: number;
        /** 语音转写模型名（同一端点） */
        asrModel: string;
      }
    | undefined;
  /** 专用 ASR 端点（OpenAI 兼容 audio/transcriptions）；未配置时回落 vision.asrModel */
  asr:
    | {
        baseUrl: string;
        apiKey: string;
        model: string;
        timeoutMs: number;
      }
    | undefined;
  /** 预判分流模型端点（未配 key 时 Triage 功能 fail-open 关闭） */
  triage:
    | {
        baseUrl: string;
        apiKey: string;
        model: string;
        timeoutMs: number;
      }
    | undefined;
  /** 直答模型端点（simple 档直答；未配置时该支路关闭） */
  fast:
    | {
        baseUrl: string;
        apiKey: string;
        model: string;
        timeoutMs: number;
      }
    | undefined;
  weknora:
    | {
        baseUrl: string;
        apiKey: string;
        timeoutMs: number;
        knowledgeBaseIds: string[] | undefined;
      }
    | undefined;
  /** CORS 白名单 origin 列表；空数组 = 不开放跨域 */
  corsOrigins: string[];
  /** WeKnora 桥接配置（账号代管 + 界面嵌入的一次性登录交换） */
  knoraBridge: {
    encKey: string | undefined;
    tenantId: number;
    emailDomain: string;
    /** WeKnora 站点 origin（无 /api/v1 后缀），用于 302 跳转到 WeKnora UI 走代管登录 */
    origin: string | undefined;
  };
};

/**
 * 从环境变量或 Secret 文件读取敏感配置值
 * 优先读取 <NAME>_FILE 指向的文件内容
 */
function secretValue(
  name:
    | "DATABASE_URL"
    | "REDIS_URL"
    | "CHANNEL_HOST_TOKEN"
    | "MODEL_API_KEY"
    | "VISION_API_KEY"
    | "WEKNORA_API_KEY"
    | "TRIAGE_API_KEY"
    | "FAST_API_KEY",
): string | undefined {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    return readFileSync(resolve(file), "utf8").trim();
  }
  return process.env[name]?.trim();
}

/** 加载并验证运行时配置 */
export function loadConfig(): RuntimeConfig {
  const parsed = environmentSchema.parse({
    ...process.env,
    DATABASE_URL: secretValue("DATABASE_URL"),
    REDIS_URL: secretValue("REDIS_URL"),
    CHANNEL_HOST_TOKEN: secretValue("CHANNEL_HOST_TOKEN"),
    MODEL_API_KEY: secretValue("MODEL_API_KEY"),
    VISION_API_KEY: secretValue("VISION_API_KEY"),
    WEKNORA_API_KEY: secretValue("WEKNORA_API_KEY"),
    TRIAGE_API_KEY: secretValue("TRIAGE_API_KEY"),
    FAST_API_KEY: secretValue("FAST_API_KEY"),
  });
  if (
    Boolean(parsed.CHANNEL_HOST_BASE_URL) !== Boolean(parsed.CHANNEL_HOST_TOKEN)
  ) {
    throw new Error(
      "CHANNEL_HOST_BASE_URL and CHANNEL_HOST_TOKEN/CHANNEL_HOST_TOKEN_FILE must be configured together",
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    healthHost: parsed.HEALTH_HOST,
    corePort: parsed.CORE_PORT,
    agentWorkerHealthPort: parsed.AGENT_WORKER_HEALTH_PORT,
    agentWorkerConcurrency: parsed.AGENT_WORKER_CONCURRENCY,
    memoryCaptureConcurrency: parsed.MEMORY_CAPTURE_CONCURRENCY,
    mediaProcessingConcurrency: parsed.MEDIA_PROCESSING_CONCURRENCY,
    ingestionWorkerHealthPort: parsed.INGESTION_WORKER_HEALTH_PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    fileStorageRoot: resolve(parsed.FILE_STORAGE_ROOT),
    channelHost:
      parsed.CHANNEL_HOST_BASE_URL && parsed.CHANNEL_HOST_TOKEN
        ? {
            baseUrl: parsed.CHANNEL_HOST_BASE_URL.replace(/\/$/, ""),
            token: parsed.CHANNEL_HOST_TOKEN,
            pollIntervalMs: parsed.CHANNEL_HOST_POLL_INTERVAL_MS,
          }
        : undefined,
    avatar: {
      proxyTimeoutMs: parsed.AVATAR_PROXY_TIMEOUT_MS,
      cacheTtlMs: parsed.AVATAR_CACHE_TTL_MS,
      allowedHosts: parsed.AVATAR_ALLOWED_HOSTS
        ? parsed.AVATAR_ALLOWED_HOSTS.split(",")
            .map((host) => host.trim())
            .filter(Boolean)
        : [],
    },
    model: parsed.MODEL_API_KEY
      ? {
          baseUrl: parsed.MODEL_BASE_URL.replace(/\/$/, ""),
          apiKey: parsed.MODEL_API_KEY,
          name: parsed.MODEL_NAME,
          timeoutMs: parsed.MODEL_TIMEOUT_MS,
        }
      : undefined,
    vision: parsed.VISION_API_KEY
      ? {
          baseUrl: parsed.VISION_BASE_URL.replace(/\/$/, ""),
          apiKey: parsed.VISION_API_KEY,
          name: parsed.VISION_MODEL,
          timeoutMs: parsed.VISION_TIMEOUT_MS,
          asrModel: parsed.ASR_MODEL,
        }
      : undefined,
    asr:
      parsed.ASR_API_KEY && parsed.ASR_BASE_URL
        ? {
            baseUrl: parsed.ASR_BASE_URL.replace(/\/$/, ""),
            apiKey: parsed.ASR_API_KEY,
            model: parsed.ASR_MODEL,
            timeoutMs: parsed.ASR_TIMEOUT_MS,
          }
        : undefined,
    triage: parsed.TRIAGE_API_KEY
      ? {
          baseUrl: parsed.TRIAGE_BASE_URL.replace(/\/$/, ""),
          apiKey: parsed.TRIAGE_API_KEY,
          model: parsed.TRIAGE_MODEL,
          timeoutMs: parsed.TRIAGE_TIMEOUT_MS,
        }
      : undefined,
    fast: parsed.FAST_API_KEY
      ? {
          baseUrl: parsed.FAST_BASE_URL.replace(/\/$/, ""),
          apiKey: parsed.FAST_API_KEY,
          model: parsed.FAST_MODEL,
          timeoutMs: parsed.FAST_TIMEOUT_MS,
        }
      : undefined,
    weknora: parsed.WEKNORA_API_KEY
      ? {
          baseUrl: parsed.WEKNORA_BASE_URL.replace(/\/$/, ""),
          apiKey: parsed.WEKNORA_API_KEY,
          timeoutMs: parsed.WEKNORA_TIMEOUT_MS,
          knowledgeBaseIds: parseKnowledgeBaseIds(
            parsed.WEKNORA_KNOWLEDGE_BASE_IDS,
          ),
        }
      : undefined,
    corsOrigins: (parsed.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    knoraBridge: {
      encKey: parsed.KNORA_ACCOUNT_ENC_KEY,
      tenantId: parsed.KNORA_TENANT_ID,
      emailDomain: parsed.KNORA_ACCOUNT_EMAIL_DOMAIN,
      origin: resolveWeknoraOrigin(parsed.WEKNORA_ORIGIN, parsed.WEKNORA_BASE_URL),
    },
  };
}

/**
 * 解析 WeKnora 站点 origin：优先用显式配置的 WEKNORA_ORIGIN；
 * 否则从 WEKNORA_BASE_URL 去掉末尾的 /api/v1（不区分大小写）。
 * 返回 undefined 表示桥接 redirect 不可用，但 launch/exchange 仍可工作。
 */
function resolveWeknoraOrigin(
  explicit: string | undefined,
  baseUrl: string,
): string | undefined {
  const candidate = (explicit ?? "").trim() || baseUrl.replace(/\/$/, "");
  return candidate.replace(/\/api\/v1\/?$/i, "") || undefined;
}

function parseKnowledgeBaseIds(
  value: string | undefined,
): string[] | undefined {
  if (!value) return undefined;
  const ids = [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}
