/**
 * dev domain 鐨勬湇鍔″畾涔夎〃锛歞octor/up/down 鐨勫敮涓€浜嬪疄鏉ユ簮銆?
 *
 * 姣忎釜鏈嶅姟鎻忚堪鍥涗欢浜嬶細
 *   - 瀹冨簲璇ョ洃鍚摢涓鍙ｏ紙浠?core/.env 鍔ㄦ€佽В鏋愶級
 *   - 鎬庝箞鍒ゅ畾瀹冨仴搴凤紙鎺㈤拡锛?
 *   - 鎬庝箞鍒ゅ畾瀹冮檲鏃э紙婧愮爜 mtime 瀵圭収杩涚▼鍚姩鏃堕棿锛?
 *   - 鎬庝箞鎶婂畠鎷夎捣鏉ワ紙鍚姩鍛戒护 / 鏃ュ織浣嶇疆 / 鏄惁闇€瑕佹彁鏉冿級
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 浠?import.meta.dirname 鍚戜笂鎵惧伐浣滃尯鏍癸紙鍚?weflow/core/.env 鐨勭洰褰曪級銆?
 * src 妯″紡涓?dist 缂栬瘧浜х墿鐨勭洰褰曟繁搴︿笉鍚岋紝蹇呴』寰幆鎺㈡祴鑰岄潪鍥哄畾灞傜骇銆?
 */
function resolveWeRoot(): string {
  let dir = dirname(import.meta.dirname);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "weflow", "core", ".env"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(import.meta.dirname, "../../../../..");
}

export const WE_ROOT = resolveWeRoot();
export const CORE_DIR = join(WE_ROOT, "weflow", "core");
export const CONSOLE_DIR = join(WE_ROOT, "weflow", "apps", "console");
export const HOST_DIR = join(WE_ROOT, "weflow", "runtimes", "channel-host-wechat");
export const DEV_LOG_DIR = join(CORE_DIR, ".dev-logs");
export const PID_FILE = join(DEV_LOG_DIR, "dev-pids.json");

/** core/.env 瑙ｆ瀽缁撴灉锛堝€煎凡鍘诲紩鍙凤級 */
export type EnvMap = Record<string, string>;

/** 绔彛瑙ｆ瀽锛氫粠 .env 璇诲彇锛岀己澶辨椂鐢ㄩ粯璁ゅ€?*/
function portFrom(env: EnvMap, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 浠?CHANNEL_HOST_BASE_URL 鎻愬彇绔彛 */
function hostPort(env: EnvMap): number {
  const raw = env.CHANNEL_HOST_BASE_URL ?? "";
  const match = /:(\d{2,5})/.exec(raw);
  return match ? Number(match[1]) : 43123;
}

export type ProbeSpec =
  | { type: "http"; path: string; accept401: boolean }
  | { type: "tcp" };

export interface ServiceDefinition {
  /** dev-pids.json 鐨勯敭锛屼篃鏄棩蹇楁枃浠跺悕鍓嶇紑 */
  key: string;
  /** 浜虹被鍙鍚嶇О */
  label: string;
  /** 绔彛瑙ｆ瀽锛堜緷璧?.env锛?*/
  port: (env: EnvMap) => number;
  probe: ProbeSpec;
  /** false = 浠?WARN锛堢己浜嗕笉闃诲 dev up 鐨?鎴愬姛"锛?*/
  required: boolean;
  /** 闄堟棫搴﹀鐓х殑婧愮爜璺緞锛堝彇鏈€鏂?mtime锛?*/
  mtimePaths: string[];
  /** 鍚姩鍙傛暟锛坅rgv锛夛紱command[0] 涓哄彲鎵ц鏂囦欢锛屽叾浣欎负鍙傛暟 */
  start: string[];
  /** 鍚姩宸ヤ綔鐩綍 */
  cwd: string;
  /** 杩涚▼鍛戒护琛岃韩浠藉尮閰嶅瓙涓诧紙浠讳竴鍛戒腑鍗虫湰椤圭洰杩涚▼锛涘尯鍒?鏈」鐩繘绋?涓?闄岀敓杩涚▼"锛?*/
  identity: string[];
  /** 闇€瑕佺鐞嗗憳鏉冮檺鎵嶈兘绠＄悊锛坈hannel-host 鐢?UAC 鍚姩鐨勫疄渚嬶級 */
  elevated: boolean;
}

const TSX_CLI = join(CORE_DIR, "node_modules", "tsx", "dist", "cli.mjs");

export { TSX_CLI };

function nodeRun(appPath: string): string[] {
  // 涓嶇敤 watch锛歞etached 鎵樼杩涚▼涓嶉渶瑕佺儹閲嶈浇锛坉octor 鐨勯檲鏃у害妫€娴嬩細鎻愮ず閲嶅惎锛夛紝
  // 涓?detached + watch 缁勫悎涓?tsx 鐨勫瓙杩涚▼浼氬湪 Windows 涓婇潤榛橀€€鍑恒€?
  return [process.execPath, "--env-file=.env", TSX_CLI, appPath];
}

export function serviceDefinitions(): ServiceDefinition[] {
  return [
    {
      key: "core-api",
      label: "Core API",
      port: (e) => portFrom(e, "CORE_PORT", 3100),
      probe: { type: "http", path: "/health/ready", accept401: false },
      required: true,
      mtimePaths: [join(CORE_DIR, "apps", "api", "main.ts")],
      start: nodeRun("apps/api/main.ts"),
      cwd: CORE_DIR,
      identity: [join(CORE_DIR, "apps", "api"), "apps/api/main.ts"],
      elevated: false,
    },
    {
      key: "agent-worker",
      label: "Agent Worker",
      port: (e) => portFrom(e, "AGENT_WORKER_HEALTH_PORT", 3101),
      probe: { type: "http", path: "/health/live", accept401: false },
      required: true,
      mtimePaths: [join(CORE_DIR, "apps", "agent-worker", "main.ts")],
      start: nodeRun("apps/agent-worker/main.ts"),
      cwd: CORE_DIR,
      identity: [join(CORE_DIR, "apps", "agent-worker"), "apps/agent-worker/main.ts"],
      elevated: false,
    },
    {
      key: "ingestion-worker",
      label: "Ingestion Worker",
      port: (e) => portFrom(e, "INGESTION_WORKER_HEALTH_PORT", 3102),
      probe: { type: "http", path: "/health/live", accept401: false },
      required: true,
      mtimePaths: [join(CORE_DIR, "apps", "ingestion-worker", "main.ts")],
      start: nodeRun("apps/ingestion-worker/main.ts"),
      cwd: CORE_DIR,
      identity: [join(CORE_DIR, "apps", "ingestion-worker"), "apps/ingestion-worker/main.ts"],
      elevated: false,
    },
    {
      key: "solution-registry",
      label: "Solution Registry",
      port: (e) => portFrom(e, "SOLUTION_REGISTRY_PORT", 3200),
      probe: { type: "tcp" },
      required: false,
      mtimePaths: [join(CORE_DIR, "apps", "solution-registry", "main.ts")],
      start: nodeRun("apps/solution-registry/main.ts"),
      cwd: CORE_DIR,
      identity: [join(CORE_DIR, "apps", "solution-registry"), "apps/solution-registry/main.ts"],
      elevated: false,
    },
    {
      key: "solution-runner",
      label: "Solution Runner",
      port: (e) => portFrom(e, "SOLUTION_RUNNER_PORT", 3201),
      probe: { type: "tcp" },
      required: false,
      mtimePaths: [join(CORE_DIR, "apps", "solution-runner", "main.ts")],
      start: nodeRun("apps/solution-runner/main.ts"),
      cwd: CORE_DIR,
      identity: [join(CORE_DIR, "apps", "solution-runner"), "apps/solution-runner/main.ts"],
      elevated: false,
    },
    {
      key: "channel-host",
      label: "Channel Host (WeChat)",
      port: (e) => hostPort(e),
      probe: { type: "http", path: "/healthz", accept401: true },
      required: true,
      mtimePaths: [join(HOST_DIR, "channel_host")],
      start: [
        join(HOST_DIR, ".venv", "Scripts", "python.exe"),
        "-m",
        "channel_host.main",
      ],
      cwd: HOST_DIR,
      identity: ["channel_host", "channel-host-wechat"],
      elevated: true,
    },
    {
      key: "console",
      label: "Console (Vite)",
      port: () => 5173,
      probe: { type: "tcp" },
      required: true,
      mtimePaths: [],
      start: [join(CONSOLE_DIR, "node_modules", ".bin", "vite.cmd"), "--port", "5173", "--strictPort"],
      cwd: CONSOLE_DIR,
      identity: ["vite", join(CONSOLE_DIR, "node_modules", ".bin", "vite")],
      elevated: false,
    },
  ];
}

/** .env 蹇呴渶閿細鍊奸潪绌猴紝鎴栧瓨鍦ㄥ悓鍓嶇紑 *_FILE 娉ㄥ叆閿?*/
export const REQUIRED_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "CORE_PORT",
  "CHANNEL_HOST_BASE_URL",
  "CHANNEL_HOST_TOKEN",
  "MODEL_BASE_URL",
  "MODEL_NAME",
  "MODEL_API_KEY",
  "WEKNORA_BASE_URL",
  "WEKNORA_API_KEY",
] as const;

