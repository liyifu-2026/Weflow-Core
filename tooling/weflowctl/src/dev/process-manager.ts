/**
 * 进程托管：dev-pids.json 的读写、detached 启动、停止（含 UAC 提权）。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EnvMap, ServiceDefinition } from "./definitions.js";

export interface PidRecord {
  pid: number;
  startedAt: number;
  elevated: boolean;
}

export type PidFile = Record<string, PidRecord>;

export function readPidFile(path: string): PidFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidFile;
  } catch {
    return {};
  }
}

export function writePidFile(path: string, records: PidFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), "utf8");
}

export function recordPid(path: string, key: string, record: PidRecord): void {
  const records = readPidFile(path);
  records[key] = record;
  writePidFile(path, records);
}

export function clearPid(path: string, key: string): void {
  const records = readPidFile(path);
  delete records[key];
  writePidFile(path, records);
}

export interface SpawnResult {
  pid: number;
}

/**
 * 以完全独立的方式启动服务（PowerShell Start-Process 中转）。
 *
 * 必须走 PS：Node 的 spawn 即便 detached 也会留在调用方的 Windows Job Object 里，
 * 终端/工具链在命令结束时收割整棵作业树，子进程收到 CTRL+C（exit 0xC000013A）
 * 静默死亡；Start-Process 创建的进程属于新的进程组 + 独立 console，不受影响
 * （这也是 run.ps1 -Detached 从来稳定的原因）。
 *
 * env 通过引导脚本注入（子进程用 --env-file 或 PS SetEnvironmentVariable），
 * 日志由 PS 重定向到 out/err 文件。返回 Start-Process -PassThru 的真实 PID。
 */
export function spawnDetached(
  service: ServiceDefinition,
  env: EnvMap,
  logOut: string,
  logErr: string,
): SpawnResult {
  mkdirSync(dirname(logOut), { recursive: true });
  const [command, ...args] = service.start;
  const exe = command ?? "";
  const quote = (s: string): string => `"${s.replaceAll('"', '""')}"`;
  const argList = args.map(quote).join(" ");

  // 引导脚本：先注入 .env 到进程环境（channel-host python 需要），再 Start-Process 脱离 Job
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `. '${join(dirname(logOut), "inject-env.ps1").replaceAll("'", "''")}'`,
    `$p = Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList '${argList.replaceAll("'", "''")}' -WorkingDirectory '${service.cwd.replaceAll("'", "''")}' -WindowStyle Hidden -RedirectStandardOutput '${logOut.replaceAll("'", "''")}' -RedirectStandardError '${logErr.replaceAll("'", "''")}' -PassThru`,
    `Write-Output $p.Id`,
  ].join("\n");

  writeFileSync(join(dirname(logOut), "inject-env.ps1"), renderEnvInjector(env), "utf8");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    return { pid: 0 };
  }
  const pid = Number(result.stdout.trim().split(/\r?\n/).at(-1));
  return { pid: Number.isFinite(pid) && pid > 0 ? pid : 0 };
}

/** 生成 inject-env.ps1：把 core/.env 写入当前 PowerShell 进程环境 */
function renderEnvInjector(env: EnvMap): string {
  const lines = [
    "$env:SetEnvironmentVariable = $null; # marker",
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(
      `[Environment]::SetEnvironmentVariable('${key}', '${value.replaceAll("'", "''")}', 'Process')`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** 普通权限停止进程（不存在的 PID 视为成功） */
export function stopProcess(pid: number): boolean {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; exit 0`],
    { encoding: "utf8", timeout: 10_000 },
  );
  return result.status === 0;
}

/**
 * UAC 提权执行一段 PowerShell 命令（Windows 专属）。
 * 会弹出系统确认框；用户取消时返回 false。
 */
export function runElevated(script: string): boolean {
  const escaped = script.replaceAll('"', '\\"');
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-NonInteractive','-Command','\"${escaped}\"' -Wait`],
    { encoding: "utf8", timeout: 120_000 },
  );
  return result.status === 0;
}

/** 停止进程：先普通权限，失败（拒绝访问）则 UAC 提权 */
export function stopProcessBestEffort(pid: number): "stopped" | "elevated" | "failed" {
  if (stopProcess(pid)) return "stopped";
  return runElevated(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; exit 0`)
    ? "elevated"
    : "failed";
}

/** 从端口反查 PID 并登记（channel-host 由 UAC 启动后无法直接拿到 PID） */
export async function adoptFromPort(
  probe: import("./probe.js").Probe,
  service: ServiceDefinition,
  env: import("./definitions.js").EnvMap,
): Promise<number | undefined> {
  const port = service.port(env);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const owners = (await probe.portOwners([port])).get(port) ?? [];
    const owner = owners[0];
    if (owner && owner.cmdline && service.identity.some((id) => owner.cmdline!.includes(id))) return owner.pid;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}
