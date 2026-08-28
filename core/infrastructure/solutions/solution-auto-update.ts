/**
 * Solution auto-update poller（P2.2：极简插件管理 / 自动升级）。
 *
 * 定期读取机器本地 CLI 配置（~/.weflow/config.json）的
 * `update.enabled` / `update.strategy` / `registry.url` / `registry.token`，
 * 对每个已安装 Solution 查询 registry 候选版本，按 semver 策略
 * （patch|minor|major|manual）解析目标并执行「下载 → 安装 → 健康门禁 →
 * 激活」。任何单点失败只告警，不阻断其他 Solution 与平台本身。
 *
 * 配置开关（与 weflowctl config 共用同一文件）：
 *   weflowctl config set update.enabled true
 *   weflowctl config set update.strategy minor
 *   weflowctl config set registry.url <url>
 *   weflowctl config set registry.token <token>
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  fetchRegistryVersions,
  downloadSolutionTarball,
} from "./solution-registry-client.js";
import {
  updateSolutionInStore,
} from "./solution-upgrade.js";
import { installSolutionPackage } from "./solution-pack.js";
import {
  getSolutionStoreRoot,
  listStoreOverviews,
} from "./solution-store.js";
import { resolveUpdateTarget } from "./solution-update.js";

export type SolutionAutoUpdateOptions = {
  intervalMs?: number;
  /** 读取 CLI 配置文件的路径（测试可注入）。 */
  configPath?: string;
  logger?: Logger;
};

type CliConfigShape = {
  registry?: { url?: string; token?: string };
  update?: { strategy?: string; enabled?: boolean };
};

export function autoUpdateConfigPath(): string {
  return join(
    process.env.WEFLOW_HOME ?? join(homedir(), ".weflow"),
    "config.json",
  );
}

/** 读取自动升级配置；缺失/非法时返回禁用。 */
export async function readAutoUpdateConfig(
  configPath: string,
): Promise<{ enabled: boolean; strategy: string; registryUrl?: string; token?: string }> {
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as CliConfigShape;
    const enabled = config.update?.enabled === true;
    const strategy = config.update?.strategy ?? "patch";
    const out: {
      enabled: boolean;
      strategy: string;
      registryUrl?: string;
      token?: string;
    } = { enabled, strategy };
    if (config.registry?.url) out.registryUrl = config.registry.url;
    if (config.registry?.token) out.token = config.registry.token;
    return out;
  } catch {
    return { enabled: false, strategy: "patch" };
  }
}

/** 执行一轮自动升级检查：返回处理的 Solution 数量。 */
export async function runSolutionAutoUpdateOnce(options: {
  configPath?: string;
  logger?: Logger;
}): Promise<number> {
  const logger = options.logger;
  const config = await readAutoUpdateConfig(
    options.configPath ?? autoUpdateConfigPath(),
  );
  if (!config.enabled) return 0;
  if (!config.registryUrl) {
    logger?.warn("solution auto-update enabled but registry.url is not set");
    return 0;
  }

  const overviews = await listStoreOverviews();
  let handled = 0;
  for (const overview of overviews) {
    if (!overview.activeVersion) continue;
    try {
      const candidates = await fetchRegistryVersions(
        config.registryUrl,
        overview.solutionId,
        config.token ? { token: config.token } : {},
      );
      const target = resolveUpdateTarget({
        candidates,
        current: overview.activeVersion,
        strategy: config.strategy as never,
      });
      if (!target) continue;

      const outcome = await updateSolutionInStore({
        solutionId: overview.solutionId,
        strategy: config.strategy as never,
        extraCandidates: candidates,
        ensureCandidate: async (version) => {
          const { tgzPath } = await downloadSolutionTarball(
            config.registryUrl!,
            overview.solutionId,
            version,
            join(getSolutionStoreRoot(), ".downloads"),
            config.token ? { token: config.token } : {},
          );
          await installSolutionPackage(tgzPath, {
            mode: "development",
          });
        },
      });
      if (outcome.status === "updated") {
        logger?.info(
          { solutionId: overview.solutionId, from: outcome.from, to: outcome.to },
          "solution auto-updated",
        );
        handled += 1;
      }
    } catch (error) {
      logger?.warn(
        { err: error, solutionId: overview.solutionId },
        "solution auto-update failed for one solution",
      );
    }
  }
  return handled;
}

/** 启动定期自动升级轮询；返回停止函数。 */
export function startSolutionAutoUpdate(options: SolutionAutoUpdateOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000; // 默认每小时
  const configPath = options.configPath ?? autoUpdateConfigPath();
  const logger = options.logger;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const tickConfig: { configPath: string; logger?: Logger } = { configPath };
      if (logger) tickConfig.logger = logger;
      await runSolutionAutoUpdateOnce(tickConfig);
    } catch (error) {
      logger?.warn({ err: error }, "solution auto-update tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
