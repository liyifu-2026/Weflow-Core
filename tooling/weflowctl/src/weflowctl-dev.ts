/**
 * dev domain 命令层：doctor / up / down。
 *
 * doctor —— 只读体检（7 类检查）
 * up     —— 体检 + 自动修复（迁移、拉起/重启托管服务、channel-host 自动 UAC）
 * down   —— 按 dev-pids.json 停止托管服务
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkChannelProtocol,
  checkService,
  runDoctor,
  summarize,
  type CheckResult,
} from "./dev/checks.js";
import {
  CORE_DIR,
  DEV_LOG_DIR,
  PID_FILE,
  WE_ROOT,
  serviceDefinitions,
  TSX_CLI,
  type EnvMap,
} from "./dev/definitions.js";
import type { ServiceDefinition } from "./dev/definitions.js";
import {
  clearPid,
  readPidFile,
  recordPid,
  spawnDetached,
  stopProcessBestEffort,
} from "./dev/process-manager.js";
import { createProbe } from "./dev/probe.js";

export const DEV_USAGE = [
  "dev  Development environment management",
  "     doctor   Health check (read-only)",
  "     up       Doctor + repair (migrate, start/restart managed services)",
  "     down     Stop managed services recorded in dev-pids.json",
  "",
  "Flags:",
  "  --json   Structured output",
].join("\n");

/** 解析 core/.env（跳过注释与空行，值去引号） */
export function loadEnvFile(path: string): EnvMap {
  const env: EnvMap = {};
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const key = match[1];
      const value = match[2]?.trim().replace(/^["']|["']$/g, "") ?? "";
      if (key) env[key] = value;
    }
  } catch {
    // 文件缺失 → 空 map，由 doctor 的 env 检查报告
  }
  return env;
}

/** 数据库表检查：动态加载 core 的 pg（零新依赖）；失败返回 undefined（降级为端口检查） */
export async function checkDbTables(env: EnvMap): Promise<
  { count: number; hasCoreTables: boolean } | undefined
> {
  try {
    const pgPath = pathToFileURL(join(CORE_DIR, "node_modules", "pg", "lib", "index.js")).href;
    const pg = (await import(pgPath)) as { Client: new (opts: object) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Array<{ n?: number; ok?: boolean }> }>; end(): Promise<void> } };
    const url = new URL(env.DATABASE_URL ?? "postgresql://127.0.0.1:5432");
    const client = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      user: url.username || undefined,
      password: url.password || undefined,
      database: url.pathname.slice(1),
      connectionTimeoutMillis: 3000,
    });
    await client.connect();
    const tables = await client.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
    );
    const core = await client.query(
      "select to_regclass('conversations') is not null as ok",
    );
    await client.end();
    return { count: tables.rows[0]?.n ?? 0, hasCoreTables: core.rows[0]?.ok === true };
  } catch {
    return undefined;
  }
}

/** 迁移：drizzle migrator 幂等，可重复执行 */
export function runMigration(env: EnvMap): boolean {
  const result = spawnSync(
    process.execPath,
    ["--env-file=.env", TSX_CLI, "infrastructure/postgres/migrate.ts"],
    { cwd: CORE_DIR, env: { ...process.env, ...env }, encoding: "utf8", timeout: 180_000 },
  );
  return result.status === 0;
}

interface RepairAction {
  service: string;
  action: "migrated" | "started" | "restarted" | "skipped_foreign" | "noop";
  detail: string;
}

/** 启动单个服务并登记 PID；等待 readiness 后从端口反查真实监听者（解决 tsx watch 父子进程偏差） */
async function startService(
  env: EnvMap,
  service: ServiceDefinition,
  probe: ReturnType<typeof createProbe>,
): Promise<number | undefined> {
  const logOut = join(DEV_LOG_DIR, `${service.key}.out.log`);
  const logErr = join(DEV_LOG_DIR, `${service.key}.err.log`);
  const { pid } = spawnDetached(service, env, logOut, logErr);
  recordPid(PID_FILE, service.key, { pid, startedAt: Date.now(), elevated: service.elevated });

  // 轮询等待：端口出现本项目监听者且探针通过（最长 30s）；
  // tsx watch 场景 spawn 的父进程不是监听者，必须以实际监听者为准登记。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const port = service.port(env);
    // 快路径：轻量 TCP 探测（毫秒级），端口不通则跳过重量级查询
    if (!(await probe.tcp(port))) continue;
    const owners = (await probe.portOwners([port])).get(port) ?? [];
    const owner = owners[0];
    const cmdline = owner?.cmdline;
    if (!owner || !cmdline || !service.identity.some((id) => cmdline.includes(id))) {
      continue;
    }
    let ready = true;
    if (service.probe.type === "http") {
      ready =
        (await probe.http(`http://127.0.0.1:${port}${service.probe.path}`, {
          accept401: service.probe.accept401,
        })) !== undefined;
    }
    if (ready) {
      recordPid(PID_FILE, service.key, {
        pid: owner.pid,
        startedAt: Date.now(),
        elevated: service.elevated,
      });
      return owner.pid;
    }
  }
  return pid;
}

async function runUp(env: EnvMap, probe: ReturnType<typeof createProbe>) {
  const actions: RepairAction[] = [];
  const services = serviceDefinitions();
  const dbTables = await checkDbTables(env);

  // 1. 迁移（Postgres 缺表时）
  if (dbTables !== undefined && !dbTables.hasCoreTables) {
    const ok = runMigration(env);
    actions.push({
      service: "postgres",
      action: ok ? "migrated" : "noop",
      detail: ok ? "迁移完成" : "迁移失败（见下方 doctor 输出）",
    });
  }

  // 2. 服务修复
  const pidFile = readPidFile(PID_FILE);
  for (const service of services) {
    const { status, pid } = await checkService(service, env, probe);
    if (status.kind === "foreign_owner") {
      actions.push({ service: service.key, action: "skipped_foreign", detail: status.detail });
      continue;
    }
    // 托管采纳：端口已被本项目健康进程占用但未登记（如 autostart 拉起、孤儿实例），
    // 把实际监听 PID 登记进 dev-pids.json，使 `dev down` 能正确清理，杜绝失控。
    if (status.kind === "pass" && pid !== undefined) {
      const recorded = pidFile[service.key]?.pid;
      if (recorded !== pid) {
        recordPid(PID_FILE, service.key, {
          pid,
          startedAt: Date.now(),
          elevated: service.elevated,
        });
        actions.push({
          service: service.key,
          action: "started",
          detail: `采纳现有健康进程 (PID ${pid}) 并登记托管`,
        });
      }
      continue;
    }
    if (
      status.kind === "not_running" ||
      status.kind === "stale" ||
      status.kind === "probe_failed"
    ) {
      // probe_failed：进程活着但探针挂（半死状态）→ 停旧拉新；
      // stale：运行旧代码 → 重启；not_running：缺失 → 启动。
      if (pid !== undefined) {
        const result = stopProcessBestEffort(pid);
        clearPid(PID_FILE, service.key);
        if (result === "failed") {
          actions.push({
            service: service.key,
            action: "noop",
            detail: `停止旧进程失败（PID ${pid}），需要管理员终端处理`,
          });
          continue;
        }
      }
      const startedPid = await startService(env, service, probe);
      actions.push({
        service: service.key,
        action: pid === undefined ? "started" : "restarted",
        detail: startedPid !== undefined ? `已启动 (PID ${startedPid})` : "启动后未探测到监听",
      });
    }
  }

  // 3. 复检
  const finalDb = await checkDbTables(env);
  const checks = await runDoctor({ env, services, probe, dbTables: finalDb, pidFile: readPidFile(PID_FILE) });
  const protocol = await loadChannelProtocol();
  if (protocol !== undefined) {
    checks.push(await checkChannelProtocol(env, probe, protocol));
  }
  const summary = summarize(checks);
  return { ok: true as const, data: { command: "up", actions, checks, summary } };
}

/** 动态加载 @weflow/contracts 的 CHANNEL_PROTOCOL（避免静态依赖，与 checkDbTables 同模式） */
async function loadChannelProtocol(): Promise<
  | { protocolVersion: number; sendOperationStates: readonly string[]; sendKinds: readonly string[] }
  | undefined
> {
  try {
    const contractsPath = pathToFileURL(join(WE_ROOT, "weflow", "packages", "contracts", "dist", "channel.js")).href;
    const contracts = (await import(contractsPath)) as { CHANNEL_PROTOCOL?: { protocolVersion: number; sendOperationStates: readonly string[]; sendKinds: readonly string[] } };
    return contracts.CHANNEL_PROTOCOL;
  } catch {
    return undefined;
  }
}

async function runDoctorCommand(env: EnvMap, probe: ReturnType<typeof createProbe>) {
  const services = serviceDefinitions();
  const dbTables = await checkDbTables(env);
  const checks = await runDoctor({ env, services, probe, dbTables, pidFile: readPidFile(PID_FILE) });
  const protocol = await loadChannelProtocol();
  if (protocol !== undefined) {
    checks.push(await checkChannelProtocol(env, probe, protocol));
  }
  const summary = summarize(checks);
  return { ok: true as const, data: { command: "doctor", checks, summary } };
}

async function runDown() {
  const pidFile = readPidFile(PID_FILE);
  const stopped: Array<{ service: string; pid: number; result: string }> = [];
  for (const [key, record] of Object.entries(pidFile)) {
    const result = stopProcessBestEffort(record.pid);
    stopped.push({ service: key, pid: record.pid, result });
    clearPid(PID_FILE, key);
  }
  return { ok: true as const, data: { command: "down", stopped } };
}

export type DevCommandResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: string; hint?: string };

export async function runDevCommand(args: string[]): Promise<DevCommandResult> {
  const command = args.find((item) => !item.startsWith("--")) ?? "";
  const env = loadEnvFile(join(CORE_DIR, ".env"));
  const probe = createProbe();

  switch (command) {
    case "doctor":
      return runDoctorCommand(env, probe);
    case "up":
      return runUp(env, probe);
    case "down":
      return runDown();
    case "":
      return { ok: true, data: { help: DEV_USAGE } };
    default:
      return {
        ok: false,
        code: "unknown_dev_command",
        error: `unknown dev command: ${command}`,
        hint: "usage: weflowctl dev doctor | up | down",
      };
  }
}

/** 渲染 dev 结果（人类模式）：检查表格 + 修复动作 + 摘要 */
export function renderDevResult(
  command: string,
  data: Record<string, unknown>,
  output: import("./cli-output.js").CliOutput,
): boolean {
  if (command === "down") {
    const stopped = (data.stopped as Array<{ service: string; pid: number; result: string }>) ?? [];
    if (stopped.length === 0) output.info("没有托管进程记录");
    for (const item of stopped) {
      output.success(`${item.service} (PID ${item.pid}) 已停止 [${item.result}]`);
    }
    return false;
  }
  const checks = (data.checks as CheckResult[] | undefined) ?? [];
  for (const check of checks) {
    const row = `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`;
    if (check.status === "pass") output.success(row);
    else if (check.status === "warn") output.warn(row);
    else output.error({ message: row, ...(check.hint ? { hint: check.hint } : {}) });
  }
  if (command === "up") {
    const actions = (data.actions as RepairAction[] | undefined) ?? [];
    if (actions.length > 0) {
      output.info("--- 修复动作 ---");
      for (const action of actions) {
        output.info(`  ${action.service}: ${action.action} — ${action.detail}`);
      }
    }
  }
  const summary = data.summary as { pass: number; warn: number; fail: number };
  output.info(`summary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  return summary.fail > 0;
}
