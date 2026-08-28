/**
 * Console / 管理端 Solution Store 投影契约。
 *
 * 这些是 Core 只读投影路由（`/api/v1/admin/solutions*`）的 wire shape；
 * Core 的 `modules/solution/interface/store-routes.ts` 与 Console 的
 * `stores/extensions.ts` 必须同时消费本文件，禁止各自手抄 DTO。
 */

/** Store 记录的一个已安装 Solution 概览（安装版本 + active 版本）。 */
export type SolutionStoreOverview = {
  solutionId: string;
  installedVersions: string[];
  activeVersion: string | null;
};

/**
 * `GET /api/v1/admin/solutions/extensions` 返回的单条投影：
 * 来自 active manifest 的 `consoleExtensions` 声明，与
 * `@weflow/solution-sdk` 的 `SolutionConsoleExtension` 一一对应并附加
 * solution 归属信息。
 */
export type ConsoleExtensionProjection = {
  solutionId: string;
  version: string;
  extensionId: string;
  title: string;
  path: string;
  entry: string;
  group?: string;
  icon?: string;
  adminOnly?: boolean;
  hidden?: boolean;
};

export type SolutionsListResponse = {
  solutions: SolutionStoreOverview[];
};

export type SolutionsExtensionsResponse = {
  solutions: ConsoleExtensionProjection[];
};

/**
 * One row in the npm-style plugin marketplace response.
 *
 * Mirrors what `/api/v1/admin/solutions/market` returns: the latest npm
 * metadata joined with the locally installed/active version (if any). The
 * field set is intentionally narrow so the Console does not have to know the
 * raw npm schema; the marketplace route normalizes everything.
 */
export type SolutionMarketplacePackage = {
  name: string;
  version: string;
  description: string;
  publisher: string;
  publishedAt: string | null;
  links: {
    npm: string | null;
    homepage: string | null;
    repository: string | null;
  };
  /** Hint from `description: icon: foo`; empty when missing. */
  icon: string;
  installedVersions: string[];
  activeVersion: string | null;
  updateAvailable: boolean;
  status: "installed" | "update-available" | "not-installed";
};

export type SolutionMarketplaceAutoUpdate = {
  enabled: boolean;
  strategy: string;
  registryUrl?: string;
  tokenSet: boolean;
};

export type SolutionMarketplaceResponse = {
  scope: string;
  registry: string;
  packages: SolutionMarketplacePackage[];
  autoUpdate: SolutionMarketplaceAutoUpdate;
};

export type SolutionMarketplaceInstallResult = {
  solutionId: string;
  version: string;
  manifestDigest: string;
  storeDir: string;
  activatedVersion: string | null;
  bytes: number;
  integrity: string | null;
};

export type SolutionMarketplaceUpdateResult =
  | { solutionId: string; status: "updated"; from: string; to: string; bytes: number; integrity: string | null }
  | { solutionId: string; status: "no-update"; current: string | null; strategy: string };

export type SolutionMarketplaceAutoUpdateResponse = {
  enabled: boolean;
  strategy: string;
};
