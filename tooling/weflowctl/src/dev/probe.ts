/**
 * 探测层：与 checks.ts 解耦的可注入依赖。
 * checks.ts 只做判定，真正的网络/进程探测都从这出去 —— 测试时替换成 fake。
 */

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

export interface TcpProbe {
  (port: number, timeoutMs?: number): Promise<boolean>;
}

export interface HttpProbe {
  (
    url: string,
    opts?: { timeoutMs?: number; accept401?: boolean },
  ): Promise<{ status: number } | undefined>;
}

export interface ProcessInfo {
  pid: number;
  /** 进程启动时间（epoch ms），拿不到为 undefined */
  startedAt?: number;
  /** 命令行（已压缩空白），拿不到为 undefined */
  cmdline?: string;
}

export interface PortOwnerProbe {
  (ports: number[]): Promise<Map<number, ProcessInfo[]>>;
}

export interface FileMtimeProbe {
  (paths: string[]): Promise<number | undefined>;
}

export interface Probe {
  tcp: TcpProbe;
  http: HttpProbe;
  portOwners: PortOwnerProbe;
  fileMtime: FileMtimeProbe;
}

export function tcpProbe(timeoutMs = 1500): TcpProbe {
  return (port) =>
    new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
}

export function httpProbe(timeoutMs = 5_000): HttpProbe {
  return async (url, opts) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? timeoutMs);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const status = response.status;
      if (opts?.accept401 && status === 401) {
        // 服务在响应但要求认证 —— 进程活着
        return { status };
      }
      return status >= 200 && status < 500 ? { status } : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * 一次性查询多个端口的监听者进程（PID + 启动时间 + 命令行）。
 * Windows 上用 PowerShell（Get-NetTCPConnection + Win32_Process 联查）。
 * 注意：PS 5.1 的 ConvertTo-Json 不支持数字键 Hashtable，输出必须用对象数组。
 */
export function portOwnerProbe(): PortOwnerProbe {
  return (ports) => new Promise((resolve) => {
    const portList = ports.join(",");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$ports = @(${portList})`,
      "$conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }",
      // 全量 Get-CimInstance 太慢会超时；按 PID 精确查询（每个 PID 一次 WMI 调用）
      "$procs = @($conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Get-CimInstance Win32_Process -Filter \"ProcessId = $_\" -ErrorAction SilentlyContinue } | Select-Object ProcessId, CreationDate, CommandLine)",
      "$rows = @()",
      "foreach ($c in $conns) {",
      "  $info = $procs | Where-Object { $_.ProcessId -eq $c.OwningProcess } | Select-Object -First 1",
      "  if ($info) {",
      "    $startedAt = ([DateTimeOffset][DateTime]$info.CreationDate).ToUnixTimeMilliseconds()",
      "    $rows += [pscustomobject]@{ port = $c.LocalPort; pid = $info.ProcessId; startedAt = $startedAt; cmdline = ($info.CommandLine -replace '\\s+', ' ') }",
      "  } else {",
      "    $rows += [pscustomobject]@{ port = $c.LocalPort; pid = $c.OwningProcess; startedAt = $null; cmdline = $null }",
      "  }",
      "}",
      "@($rows) | ConvertTo-Json -Compress -Depth 5",
    ].join("; ");
    const output = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const map = new Map<number, ProcessInfo[]>();
    if (output.status !== 0 || !output.stdout.trim()) {
      resolve(map);
      return;
    }
    try {
      // PS 5.1 的 ConvertTo-Json 对单元素数组会塌缩成对象，这里兼容两种形状
      const parsed = JSON.parse(output.stdout) as
        | Array<{ port: number; pid: number; startedAt?: number | null; cmdline?: string | null }>
        | { port: number; pid: number; startedAt?: number | null; cmdline?: string | null };
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        const infos = map.get(row.port) ?? [];
        infos.push({
          pid: row.pid,
          ...(row.startedAt !== undefined && row.startedAt !== null ? { startedAt: row.startedAt } : {}),
          ...(row.cmdline !== undefined && row.cmdline !== null ? { cmdline: row.cmdline } : {}),
        });
        map.set(row.port, infos);
      }
    } catch {
      // 解析失败按"未知"处理，由 checks 判定为 WARN
    }
    resolve(map);
  });
}

export function fileMtimeProbe(): FileMtimeProbe {
  return async (paths) => {
    let latest: number | undefined;
    for (const p of paths) {
      // 目录取递归最新 mtime（spawnSync 找文件太慢，用 PowerShell 一次搞定）
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$p = '${p.replaceAll("'", "''")}'`,
        "$items = Get-Item $p -ErrorAction SilentlyContinue",
        "if ($items -and $items.PSIsContainer) { $items = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue }",
        "$max = ($items | Measure-Object -Property LastWriteTime -Maximum -ErrorAction SilentlyContinue).Maximum",
        "if ($max) { [DateTimeOffset]::new([DateTime]$max, [TimeSpan]::Zero).ToUnixTimeMilliseconds() }",
      ].join("; ");
      const output = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 20_000,
      });
      if (output.status === 0 && output.stdout.trim()) {
        const ts = Number(output.stdout.trim());
        if (Number.isFinite(ts) && ts > 0) latest = Math.max(latest ?? 0, ts);
      }
    }
    return latest;
  };
}

export function createProbe(): Probe {
  return {
    tcp: tcpProbe(),
    http: httpProbe(),
    portOwners: portOwnerProbe(),
    fileMtime: fileMtimeProbe(),
  };
}
