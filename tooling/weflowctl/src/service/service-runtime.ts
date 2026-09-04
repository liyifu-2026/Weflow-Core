/**
 * service 命令层：install / uninstall / start / stop / restart / status。
 *
 * 执行路径（Windows）：
 *   - 配置落盘：tools/winsw/ 下复制 weflow-service.exe 为 <service>.exe +
 *     写 <service>.xml（WinSW 约定：同名同目录配对）
 *   - 服务控制：`<service>.exe <action>`（WinSW 自带 install/start/stop/
 *     uninstall/status 动词，内部调用 sc），避免直接拼 sc.exe 转义
 *
 * 前置检查失败时返回结构化错误（缺 node.exe、缺 dist、缺 tools/winsw host）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVICE_KEYS,
  SERVICE_USAGE,
  WINSW_HOST_EXE,
  renderWinswXml,
  serviceNames,
  type ServiceCommandResult,
  type ServiceStatusRow,
} from "./definitions.js";
import { loadEnvFile } from "../weflowctl-dev.js";
import { CORE_DIR } from "../dev/definitions.js";

/** weflowctl 仓库根（src/service/../..，dist 与源码深度一致则环形上探 package.json） */
function resolveWeflowctlRoot(): string {
  let dir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
        if (pkg.name === "weflowctl") return dir;
      } catch {
        // fall through
      }
    }
    dir = dirname(dir);
  }
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

const WEFLOWCTL_ROOT = resolveWeflowctlRoot();
/**
 * WinSW host exe 与服务配置落盘目录：<weflow>/tools/winsw。
 * WEFLOWCTL_ROOT = <weflow>/tooling/weflowctl，向上两级 = <weflow>。
 */
export const WINSW_DIR = join(dirname(dirname(WEFLOWCTL_ROOT)), "tools", "winsw");
/** 服务运行日志目录 */
export const SERVICE_LOG_DIR = join(dirname(dirname(WEFLOWCTL_ROOT)), "tools", "winsw", "logs");

/** WinSW host exe 获取页（版本锁定，见部署文档） */
export const WINSW_DOWNLOAD_URL =
  "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";

function nodeExePath(): string {
  return process.execPath;
}

function hostExePath(): string {
  return join(WINSW_DIR, WINSW_HOST_EXE);
}

/** service install 的前置条件检查；返回错误信息（undefined = 通过） */
export function checkInstallPrerequisites(
  coreDir: string,
  env: Record<string, string>,
): string | undefined {
  if (!existsSync(join(coreDir, "dist", "apps", "api", "main.js"))) {
    return `core 未构建：缺 ${join(coreDir, "dist", "apps", "api", "main.js")}，先在 core 目录执行 pnpm build`;
  }
  if (!env.DATABASE_URL || !env.REDIS_URL) {
    return "core/.env 缺 DATABASE_URL/REDIS_URL；先按 .env.production.example 配置生产 .env";
  }
  if (!existsSync(hostExePath())) {
    return `缺 WinSW host：${hostExePath()}。下载 ${WINSW_DOWNLOAD_URL} 并保存为该文件名（见 docs/deployment-guide.md「服务化」）`;
  }
  return undefined;
}

interface ActionOutcome {
  service: string;
  action: string;
  ok: boolean;
  detail: string;
}

function runWinsw(exe: string, action: string): { ok: boolean; detail: string } {
  const result = spawnSync(exe, [action], { encoding: "utf8", timeout: 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, detail: output.split(/\r?\n/).at(-1) ?? `exit ${result.status}` };
}

/** 对全部服务执行一个 WinSW 动词 */
function forEachService(
  action: "install" | "uninstall" | "start" | "stop" | "restart",
): ServiceCommandResult {
  const env = loadEnvFile(join(CORE_DIR, ".env"));
  if (action === "install") {
    const problem = checkInstallPrerequisites(CORE_DIR, env);
    if (problem) {
      return { ok: false, code: "install_prerequisite_failed", error: problem };
    }
  } else if (action !== "uninstall" && !existsSync(hostExePath())) {
    return {
      ok: false,
      code: "winsw_host_missing",
      error: `缺 WinSW host：${hostExePath()}`,
      hint: "先执行 weflowctl service install（会生成 host 与配置）",
    };
  }

  const outcomes: ActionOutcome[] = [];
  for (const key of SERVICE_KEYS) {
    const { serviceName } = serviceNames(key);
    const exe = join(WINSW_DIR, `${serviceName}.exe`);
    const xml = join(WINSW_DIR, `${serviceName}.xml`);

    if (action === "install") {
      mkdirSync(WINSW_DIR, { recursive: true });
      mkdirSync(SERVICE_LOG_DIR, { recursive: true });
      copyFileSync(hostExePath(), exe);
      const nodeExe = nodeExePath();
      writeFileSync(xml, renderWinswXml(CORE_DIR, nodeExe, key, SERVICE_LOG_DIR), "utf8");
    }

    const result = runWinsw(exe, action);
    outcomes.push({
      service: serviceName,
      action,
      ok: result.ok,
      detail: result.detail || (result.ok ? "ok" : "failed"),
    });
  }
  const failed = outcomes.filter((o) => !o.ok);
  return {
    ok: true,
    data: {
      command: action,
      outcomes,
      summary: `${outcomes.length - failed.length}/${outcomes.length} 成功`,
      ...(failed.length > 0 ? { hint: "安装/控制服务需要管理员终端（UAC）；WinSW 输出见上方 detail" } : {}),
    },
  };
}

function statusAll(): ServiceCommandResult {
  const rows: ServiceStatusRow[] = [];
  for (const key of SERVICE_KEYS) {
    const { serviceName } = serviceNames(key);
    const exe = join(WINSW_DIR, `${serviceName}.exe`);
    if (!existsSync(exe)) {
      rows.push({ service: serviceName, state: "not_installed", detail: "未安装（缺 host exe）" });
      continue;
    }
    const result = runWinsw(exe, "status");
    rows.push({
      service: serviceName,
      state: result.ok ? "running" : "stopped",
      detail: result.detail,
    });
  }
  return { ok: true, data: { command: "status", rows } };
}

/** 下载 WinSW host exe（v2.12.0，锁版本）；已存在时跳过 */
async function fetchWinswHost(): Promise<ServiceCommandResult> {
  if (existsSync(hostExePath())) {
    return { ok: true, data: { command: "fetch-host", path: hostExePath(), detail: "已存在，跳过下载" } };
  }
  mkdirSync(WINSW_DIR, { recursive: true });
  const response = await fetch(WINSW_DOWNLOAD_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    return {
      ok: false,
      code: "winsw_download_failed",
      error: `下载失败：HTTP ${response.status}`,
      hint: `手动下载 ${WINSW_DOWNLOAD_URL} 并保存为 ${hostExePath()}`,
    };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(hostExePath(), buffer);
  return {
    ok: true,
    data: { command: "fetch-host", path: hostExePath(), bytes: buffer.length },
  };
}

export async function runServiceCommand(args: string[]): Promise<ServiceCommandResult> {
  const command = args.find((item) => !item.startsWith("--")) ?? "";
  switch (command) {
    case "install":
    case "uninstall":
    case "start":
    case "stop":
    case "restart":
      return forEachService(command);
    case "status":
      return statusAll();
    case "fetch-host":
      return fetchWinswHost();
    case "":
      return { ok: true, data: { help: SERVICE_USAGE } };
    default:
      return {
        ok: false,
        code: "unknown_service_command",
        error: `unknown service command: ${command}`,
        hint: "usage: weflowctl service install|uninstall|start|stop|restart|status|fetch-host",
      };
  }
}

/** 渲染 service 结果（人类模式）；返回是否存在失败 */
export function renderServiceResult(
  command: string,
  data: Record<string, unknown>,
  output: import("../cli-output.js").CliOutput,
): boolean {
  if (data.help !== undefined) {
    output.info(String(data.help));
    return false;
  }
  if (command === "fetch-host") {
    output.success(`WinSW host 就绪：${String(data.path)}${data.detail ? `（${String(data.detail)}）` : ""}`);
    return false;
  }
  if (command === "status") {
    const rows = (data.rows as ServiceStatusRow[]) ?? [];
    for (const row of rows) {
      const line = `${row.service}: ${row.state} — ${row.detail}`;
      if (row.state === "running") output.success(line);
      else if (row.state === "not_installed") output.warn(line);
      else output.error({ message: line });
    }
    return false;
  }
  const outcomes = (data.outcomes as ActionOutcome[]) ?? [];
  for (const outcome of outcomes) {
    const line = `${outcome.service} ${outcome.action}: ${outcome.detail}`;
    if (outcome.ok) output.success(line);
    else output.error({ message: line });
  }
  if (data.summary !== undefined) output.info(String(data.summary));
  if (data.hint !== undefined) output.warn(String(data.hint));
  return outcomes.some((o) => !o.ok);
}
