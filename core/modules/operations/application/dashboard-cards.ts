/**
 * 平台总览业务卡片（dashboardContributions）
 *
 * 从已激活 Solution 的 manifest.dashboardContributions 读取卡片声明，
 * 按 metric key 计算平台指标，返回前端 OverviewV2 可渲染的结构。
 * 业务内容由 Solution 声明，平台只负责承载与计算通用指标。
 */
import { sql } from "drizzle-orm";
import { join } from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describeSolution } from "@weflow-leaif/solution-sdk";
import type { SolutionManifestV1 } from "@weflow-leaif/solution-sdk";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { readManifestFile } from "../../../infrastructure/solutions/solution-stage.js";
import {
  getSolutionStoreRoot,
  listStoreOverviews,
} from "../../../infrastructure/solutions/solution-store.js";

/** 前端 OverviewV2 的 DashboardCard 投影 */
export type DashboardCardView = {
  id: string;
  title: string;
  solutionId: string;
  position: { x: number; y: number; w: number; h: number };
  refreshInterval?: number;
  data: {
    value?: number;
    unit?: string;
  } | null;
  href?: string;
  status: "ready" | "empty";
  error: string | null;
};

type MetricKey = NonNullable<
  NonNullable<SolutionManifestV1["dashboardContributions"]>[number]["metric"]
>;

async function computeMetrics(
  db: NodePgDatabase<typeof schema>,
  keys: MetricKey[],
): Promise<Partial<Record<MetricKey, number>>> {
  const out: Partial<Record<MetricKey, number>> = {};
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  for (const key of keys) {
    if (key === "today_conversations") {
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(schema.conversations)
        .where(sql`${schema.conversations.createdAt} >= ${startOfDay}`);
      out[key] = rows[0]?.value ?? 0;
    } else if (key === "pending_handoffs") {
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(schema.handoffStates)
        .where(
          sql`${schema.handoffStates.status} in ('pending', 'transfer_pending')`,
        );
      out[key] = rows[0]?.value ?? 0;
    } else if (key === "active_solutions") {
      const overviews = await listStoreOverviews();
      out[key] = overviews.filter((item) => item.activeVersion !== null).length;
    }
  }
  return out;
}

/** 构建平台总览卡片列表（按 manifest 声明顺序；未声明返回空数组） */
export async function buildDashboardCards(
  db: NodePgDatabase<typeof schema>,
): Promise<DashboardCardView[]> {
  const root = getSolutionStoreRoot();
  const overviews = await listStoreOverviews();
  const contributions: Array<{
    solutionId: string;
    card: NonNullable<SolutionManifestV1["dashboardContributions"]>[number];
  }> = [];
  for (const overview of overviews) {
    if (!overview.activeVersion) continue;
    const activeDir = join(root, overview.solutionId, overview.activeVersion);
    let manifest: SolutionManifestV1;
    try {
      manifest = describeSolution(await readManifestFile(activeDir)).manifest;
    } catch {
      continue;
    }
    for (const card of manifest.dashboardContributions ?? []) {
      contributions.push({ solutionId: overview.solutionId, card });
    }
  }
  if (contributions.length === 0) return [];

  const metricKeys = [
    ...new Set(
      contributions
        .map((item) => item.card.metric)
        .filter((m): m is MetricKey => m !== undefined),
    ),
  ];
  const metrics =
    metricKeys.length > 0 ? await computeMetrics(db, metricKeys) : {};

  return contributions.map(({ solutionId, card }, index) => ({
    id: `${solutionId}:${card.id}`,
    title: card.title,
    solutionId,
    position: { x: (index % 3) * 4, y: Math.floor(index / 3) * 2, w: 4, h: 2 },
    ...(card.metric ? { refreshInterval: 60_000 } : {}),
    data: card.metric
      ? { value: metrics[card.metric] ?? 0, ...(card.unit ? { unit: card.unit } : {}) }
      : null,
    ...(card.href ? { href: card.href } : {}),
    status: "ready",
    error: null,
  }));
}
