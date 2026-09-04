/**
 * Console / 管理端投影契约。
 *
 * R3 平台化拆除后不再有 Solution Store / consoleExtensions / npm 市场，
 * 这里只保留 `/api/v1/admin/console/home` 的 wire shape。
 */

export type ConsoleHomeResponse = {
  solutions: unknown[];
  cards: unknown[];
  systemStatus: {
    components: Array<{ key: string; name: string; status: string }>;
    turnCounts: Record<string, number>;
  };
};
