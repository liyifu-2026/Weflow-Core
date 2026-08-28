/**
 * 检查器：doctor 的判定逻辑，全部纯函数 + 注入探测依赖。
 * 每项检查返回 CheckResult，由命令层渲染。
 */

import type { EnvMap, ServiceDefinition } from "./definitions.js";
import { REQUIRED_ENV_KEYS } from "./definitions.js";
import type { Probe } from "./probe.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  env: EnvMap;
  services: ServiceDefinition[];
  probe: Probe;
  /** PID 文件内容（readPidFile 的输出；undefined = 无托管记录） */
  pidFile?: Record<string, { pid: number; startedAt?: number; elevated?: boolean }>;
  /** 迁移是否已跑（postgres 表检查结果，由命令层传入以复用连接） */
  dbTables?: { count: number; hasCoreTables: boolean } | undefined;
}

/** DATABASE_URL/REDIS_URL 解析端口 */
function urlPort(url: string | undefined, fallback: number): number {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    return Number(parsed.port) || fallback;
  } catch {
    return fallback;
  }
}

/** .env 必需键检查 */
export function checkEnv(env: EnvMap, requiredKeys: readonly string[]): CheckResult {
  const missing = requiredKeys.filter((key) => {
    const value = env[key]?.trim();
    if (value) return false;
    // 允许 *_FILE 注入形式（值可能写在单独文件里）
    return env[`${key}_FILE`] === undefined;
  });
  return {
    id: "env",
    name: ".env 必需键",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? "必需键齐全"
        : `缺失: ${missing.join(", ")}`,
    ...(missing.length > 0
      ? { hint: "检查 weflow/core/.env 是否被覆盖或截断" }
      : {}),
  };
}

/** Postgres 可达 + 迁移已跑 */
export async function checkPostgres(
  env: EnvMap,
  probe: Probe,
  dbTables?: DoctorOptions["dbTables"],
): Promise<CheckResult> {
  const port = urlPort(env.DATABASE_URL, 5432);
  const reachable = await probe.tcp(port);
  if (!reachable) {
    return {
      id: "postgres",
      name: "Postgres",
      status: "fail",
      detail: `端口 ${port} 不可达`, 
      hint: "检查 PostgreSQL 服务是否启动",
    };
  }
  return {
    id: "postgres",
    name: "Postgres",
    status: dbTables === undefined || dbTables.hasCoreTables ? "pass" : "fail",
    detail:
      dbTables === undefined
        ? `端口 ${port} 可达`
        : dbTables.hasCoreTables
          ? `端口 ${port} 可达，业务表已建（${dbTables.count} 张）`
          : `端口 ${port} 可达但业务表缺失（仅 ${dbTables.count} 张表）——数据库可能是空库`,
    ...(dbTables !== undefined && !dbTables.hasCoreTables
      ? { hint: "运行 `weflowctl dev up` 自动执行迁移" }
      : {}),
  };
}

/** Redis 可达 */
export function checkRedis(env: EnvMap, probe: Probe): Promise<CheckResult> {
  const port = urlPort(env.REDIS_URL, 6379);
  return probe.tcp(port).then((ok) => ({
    id: "redis",
    name: "Redis",
    status: ok ? "pass" : "fail",
    detail: ok ? `端口 ${port} 可达` : `端口 ${port} 不可达`,
    ...(ok ? {} : { hint: "检查 Redis 服务是否启动" }),
  }));
}

export type ServiceCheckStatus =
  | { kind: "pass"; detail: string }
  | { kind: "stale"; detail: string }
  | { kind: "probe_failed"; detail: string }
  | { kind: "not_running"; detail: string }
  | { kind: "foreign_owner"; detail: string; hint: string }
  | { kind: "unknown_owner"; detail: string };

/** 单个服务的体检（端口归属 → 身份 → 探针 → 陈旧度） */
export async function checkService(
  service: ServiceDefinition,
  env: EnvMap,
  probe: Probe,
): Promise<{ status: ServiceCheckStatus; pid?: number }> {
  const port = service.port(env);
  const owners = (await probe.portOwners([port])).get(port) ?? [];
  const owner = owners[0];

  if (!owner) {
    return {
      status: { kind: "not_running", detail: `端口 ${port} 无监听` },
    };
  }

  // 身份判定：命令行任一特征子串命中即本项目进程；空命令行（管理员进程）无法判定 → unknown
  const hasCmdline = owner.cmdline !== undefined && owner.cmdline.trim() !== "";
  const identityMatch = hasCmdline && service.identity.some((id) => owner.cmdline!.includes(id));
  const foreign = hasCmdline && !identityMatch;

  if (foreign) {
    return {
      status: {
        kind: "foreign_owner",
        detail: `端口 ${port} 被陌生进程占用 (PID ${owner.pid})`,
        hint: "需要你在管理员终端确认并停掉该进程，`dev up` 不会自动杀",
      },
    };
  }

  // 探针（失败后重试一次，避免高负载下瞬时抖动误报）
  let alive = false;
  if (service.probe.type === "http") {
    const url = `http://127.0.0.1:${port}${service.probe.path}`;
    alive = (await probe.http(url, { accept401: service.probe.accept401 })) !== undefined;
    if (!alive) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      alive = (await probe.http(url, { accept401: service.probe.accept401 })) !== undefined;
    }
  } else {
    alive = await probe.tcp(port);
  }

  if (!alive) {
    return {
      pid: owner.pid,
      status: {
        kind: "probe_failed",
        detail: `端口 ${port} 有监听 (PID ${owner.pid}) 但探针失败`,
      },
    };
  }

  // 陈旧度：源码 mtime > 进程启动时间 → stale
  if (service.mtimePaths.length > 0 && owner.startedAt !== undefined) {
    const latestSource = await probe.fileMtime(service.mtimePaths);
    if (latestSource !== undefined && latestSource > owner.startedAt + 30_000) {
      return {
        pid: owner.pid,
        status: {
          kind: "stale",
          detail: `进程 (PID ${owner.pid}) 启动于 ${new Date(owner.startedAt).toISOString()}，晚于最新源码修改 —— 运行的是旧代码`,
        },
      };
    }
  }

  return {
    pid: owner.pid,
    status: { kind: "pass", detail: `端口 ${port} 监听正常，探针通过 (PID ${owner.pid})` },
  };
}

/** 服务组检查：把单服务体检折叠成 CheckResult（含 required 级别） */
export function serviceChecks(
  services: ServiceDefinition[],
  env: EnvMap,
  probe: Probe,
  pidFile?: DoctorOptions["pidFile"],
): Promise<CheckResult[]> {
  return Promise.all(
    services.map(async (service) => {
      const { status, pid } = await checkService(service, env, probe);
      const severity = (kind: ServiceCheckStatus["kind"]): CheckStatus => {
        if (kind === "pass") return "pass";
        if (kind === "stale") return service.required ? "warn" : "warn";
        if (kind === "unknown_owner") return "warn";
        return service.required ? "fail" : "warn";
      };
      const recorded = pidFile?.[service.key];
      const detailParts: string[] = [status.detail];
      if (recorded && pid !== undefined && recorded.pid === pid) {
        detailParts.push("[托管记录一致]");
      } else if (recorded && pid === undefined) {
        detailParts.push("[托管记录 PID 已失效]");
      } else if (recorded && pid !== undefined && recorded.pid !== pid) {
        detailParts.push(`[托管记录 PID ${recorded.pid} ≠ 实际 ${pid}]`);
      }
      return {
        id: `service:${service.key}`,
        name: service.label,
        status: severity(status.kind),
        detail: detailParts.join(" "),
        ...(status.kind === "foreign_owner" ? { hint: status.hint } : {}),
      };
    }),
  );
}

/** 汇总全部检查 */
export async function runDoctor(options: DoctorOptions): Promise<CheckResult[]> {
  const { env, services, probe, pidFile, dbTables } = options;
  const results: CheckResult[] = [];
  results.push(checkEnv(env, REQUIRED_ENV_KEYS));
  results.push(await checkPostgres(env, probe, dbTables));
  results.push(await checkRedis(env, probe));
  results.push(...(await serviceChecks(services, env, probe, pidFile)));
  return results;
}

/**
 * Channel 协议对账：GET host /capabilities 与 @weflow/contracts 的 CHANNEL_PROTOCOL 比对。
 * protocol 由命令层动态加载（避免 weflowctl 静态依赖 contracts 包）。
 */
export async function checkChannelProtocol(
  env: EnvMap,
  probe: Probe,
  protocol: {
    protocolVersion: number;
    sendOperationStates: readonly string[];
    sendKinds: readonly string[];
  },
): Promise<CheckResult> {
  const baseUrl = env.CHANNEL_HOST_BASE_URL?.replace(/\/$/, "");
  const token = env.CHANNEL_HOST_TOKEN;
  if (!baseUrl || !token) {
    return {
      id: "channel-protocol",
      name: "Channel 协议对齐",
      status: "warn",
      detail: "CHANNEL_HOST_BASE_URL/CHANNEL_HOST_TOKEN 缺失，跳过",
    };
  }
  const resp = await probe.http(`${baseUrl}/api/v1/channel/capabilities`, { accept401: true });
  if (resp === undefined) {
    return {
      id: "channel-protocol",
      name: "Channel 协议对齐",
      status: "warn",
      detail: "host 不可达或未实现 /capabilities，跳过",
    };
  }
  // 带 token 请求真实能力（401/200 都继续；只有非 2xx 且非 401 视为异常）
  const fetchImpl = globalThis.fetch.bind(globalThis);
  let payload: Record<string, unknown> | undefined;
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/channel/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // 落到下面的缺失分支
  }
  if (payload === undefined) {
    return {
      id: "channel-protocol",
      name: "Channel 协议对齐",
      status: "warn",
      detail: "host /capabilities 返回异常，跳过",
    };
  }
  const problems: string[] = [];
  if (payload["protocolVersion"] !== protocol.protocolVersion) {
    problems.push(
      `protocolVersion ${String(payload["protocolVersion"])} != ${String(protocol.protocolVersion)}`,
    );
  }
  const states = new Set(Array.isArray(payload["sendOperationStates"]) ? (payload["sendOperationStates"] as string[]) : []);
  for (const state of protocol.sendOperationStates) {
    if (!states.has(state)) problems.push(`缺 sendOperationState: ${state}`);
  }
  const kinds = new Set(Array.isArray(payload["sendKinds"]) ? (payload["sendKinds"] as string[]) : []);
  for (const kind of protocol.sendKinds) {
    if (!kinds.has(kind)) problems.push(`缺 sendKind: ${kind}`);
  }
  return {
    id: "channel-protocol",
    name: "Channel 协议对齐",
    status: problems.length === 0 ? "pass" : "fail",
    detail:
      problems.length === 0
        ? `protocol v${String(payload["protocolVersion"])} 与 @weflow/contracts 一致`
        : `失配: ${problems.join("; ")}`,
    ...(problems.length > 0
      ? { hint: "运行 sync-channel-protocol.ts 重新生成 host 侧 channel_protocol.py 并重启 channel-host" }
      : {}),
  };
}

export function summarize(results: CheckResult[]): { pass: number; warn: number; fail: number } {
  return {
    pass: results.filter((r) => r.status === "pass").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
  };
}
