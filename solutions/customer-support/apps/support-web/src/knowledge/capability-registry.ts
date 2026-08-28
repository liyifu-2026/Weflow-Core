/**
 * Knowledge capability registry — three layers of truth, one derived
 * product state.
 *
 * The registry NEVER collapses "upstream can do it", "Core exposes it"
 * and "the Weflow UI implements it" into a single `available` flag. A
 * capability is only `available` to users when all three layers are green.
 *
 *   upstream:        what the WeKnora deployment can do (runtime probe)
 *   serverContract:  what Core's knowledge boundary exposes (whitelist)
 *   ui:              what the Weflow UI actually implements
 *
 * Product language is derived separately — never show `serverContract`
 * or `upstream` to users.
 */
import { shallowRef } from "vue";

export type KnowledgeCapability =
  | "validate"
  | "documents"
  | "chunks"
  | "faq"
  | "wiki"
  | "datasources"
  | "parser"
  | "retrieval"
  | "models"
  | "vectorStores"
  | "storage"
  | "activity";

export type CapabilityLayer = "available" | "blocked" | "missing";
export type CapabilityUi = "implemented" | "partial" | "missing";

export type KnowledgeCapabilityState = {
  capability: KnowledgeCapability;
  upstream: CapabilityLayer;
  serverContract: CapabilityLayer;
  ui: CapabilityUi;
  /** Technical truth for the audit trail — never rendered to users. */
  reason?: string;
};

export type ProductState =
  | "available"
  | "read_only"
  | "not_integrated"
  | "temporarily_unavailable"
  | "unsupported";

/**
 * Baseline from the runtime capability audit (2026-08-11/12):
 * - models / vectorStores / storage: managed endpoints wired (G1) → available;
 *   datasources stays read_only (sync writes pending explicit need).
 * - activity: upstream blocks it with an independent scope check (403 even
 *   with full_access) → temporarily_unavailable.
 * - parser: upstream has no parser registry routes → unsupported.
 * - retrieval: upstream 200, Core whitelist missing tenants/kv → fixed by
 *   an explicit retrieval-settings contract (P0.2), then becomes available.
 */
const BASELINE: Record<KnowledgeCapability, KnowledgeCapabilityState> = {
  validate: {
    capability: "validate",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "knowledge-search POST whitelisted, verified 200",
  },
  documents: {
    capability: "documents",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "knowledge-bases/* + knowledge/* whitelisted, verified 200",
  },
  chunks: {
    capability: "chunks",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "chunks/* whitelisted, verified 200 (incl. by-id)",
  },
  faq: {
    capability: "faq",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "knowledge-bases/{id}/faq/* whitelisted; upstream rejects on non-FAQ KBs",
  },
  wiki: {
    capability: "wiki",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "knowledgebase/{id}/wiki/* whitelisted, verified 200",
  },
  datasources: {
    capability: "datasources",
    upstream: "available",
    serverContract: "available",
    ui: "partial",
    reason: "API 200 after key scope fix; read-only bindings wired (P4), writes pending explicit need",
  },
  parser: {
    capability: "parser",
    upstream: "missing",
    serverContract: "missing",
    ui: "missing",
    reason: "upstream has no parser registry routes; only chunker/preview POST",
  },
  retrieval: {
    capability: "retrieval",
    upstream: "available",
    serverContract: "blocked",
    ui: "missing",
    reason: "upstream tenants/kv 200; Core whitelist missing — explicit retrieval-settings contract (P0.2)",
  },
  models: {
    capability: "models",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "managed create/delete via /admin/knowledge-models (G1)",
  },
  vectorStores: {
    capability: "vectorStores",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "managed create + connection test via /admin/knowledge-vector-stores (G1)",
  },
  storage: {
    capability: "storage",
    upstream: "available",
    serverContract: "available",
    ui: "implemented",
    reason: "managed create via /admin/knowledge-storage-backends (G1)",
  },
  activity: {
    capability: "activity",
    upstream: "blocked",
    serverContract: "available",
    ui: "implemented",
    reason: "upstream 403 independent of full_access (needs system-admin scope)",
  },
};

const states = new Map<KnowledgeCapability, KnowledgeCapabilityState>(
  Object.entries(BASELINE) as [KnowledgeCapability, KnowledgeCapabilityState][],
);

// 运行时升级（updateKnowledgeCapability）必须能被 Vue 观察到：computed
// 依赖 revision 重新求值，否则页面永远显示基线状态（P0.2 遗留 bug）。
const revision = shallowRef(0);

export function useKnowledgeCapability(
  capability: KnowledgeCapability,
): KnowledgeCapabilityState {
  revision.value;
  return states.get(capability) ?? {
    capability,
    upstream: "missing",
    serverContract: "missing",
    ui: "missing",
  };
}

export function listKnowledgeCapabilities(): KnowledgeCapabilityState[] {
  revision.value;
  return [...states.values()];
}

/** Set a layer after a successful runtime probe or contract change. */
export function updateKnowledgeCapability(
  capability: KnowledgeCapability,
  patch: Partial<
    Pick<
      KnowledgeCapabilityState,
      "upstream" | "serverContract" | "ui" | "reason"
    >
  >,
) {
  const state = states.get(capability);
  if (state) {
    Object.assign(state, patch);
    revision.value += 1;
  }
}

/** Derived product state — the only value that reaches user-facing copy. */
export function productStateOf(
  state: KnowledgeCapabilityState,
): ProductState {
  if (state.upstream === "missing" || state.serverContract === "missing")
    return "unsupported";
  if (state.upstream === "blocked") return "temporarily_unavailable";
  if (state.serverContract === "blocked")
    return "temporarily_unavailable";
  if (state.ui === "missing") return "not_integrated";
  if (state.ui === "partial") return "read_only";
  return "available";
}

/** Product-language copy for a product state — never leak layer facts. */
export function productStateCopy(
  state: ProductState,
): { title: string; detail: string } {
  switch (state) {
    case "available":
      return { title: "可用", detail: "" };
    case "read_only":
      return { title: "只读", detail: "当前部署仅开放读取。" };
    case "not_integrated":
      return {
        title: "尚未接入",
        detail: "底层能力已就绪，管理界面正在接入中。",
      };
    case "temporarily_unavailable":
      return {
        title: "暂不可用",
        detail: "当前部署尚未开放此项能力。",
      };
    default:
      return {
        title: "当前部署不支持",
        detail: "此能力在当前部署中不可用。",
      };
  }
}

