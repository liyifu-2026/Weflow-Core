/**
 * Standalone dev-mode stub for the Solution API bridge.
 *
 * The embedded Console ExtensionHost injects a real `setApiBridge` and
 * `setAuthBridge` at mount time, so production never reaches this file.
 * For local `pnpm dev` and Playwright verification we still want a
 * deterministic surface that mimics the real Core responses closely enough
 * for the AI Employee page (and other admin pages) to render.
 *
 * Stub rules:
 * - `GET /api/v1/auth/me` always returns an admin user.
 * - `/api/v1/agent/ai-employees` and friends return empty success payloads.
 * - `/api/v1/contacts?limit=100` returns a tiny contact fixture so the
 *   bindings rail is not empty.
 * - Any other path falls through to real `fetch` (Vite proxy).
 */
import type { BridgeFetch } from "./api";
import { setApiBridge } from "./api";
import { setAuthBridge } from "./auth-store";

const STUB_CONTACTS = [
  {
    contactId: "contact:stub-001",
    channelDisplayName: "李工",
    channelNickname: "李工",
    channelRemark: "渠道客户",
    sharedAlias: "VIP-001",
  },
  {
    contactId: "contact:stub-002",
    channelDisplayName: "王女士",
    channelNickname: "王女士",
    channelRemark: null,
    sharedAlias: null,
  },
];

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isAiEmployeesPath(path: string): boolean {
  return (
    path === "/api/v1/agent/ai-employees" ||
    path.startsWith("/api/v1/agent/ai-employees/") ||
    path === "/api/v1/agent/workspace-default" ||
    path.startsWith("/api/v1/agent/workspace-default") ||
    path === "/api/v1/agent/contact-bindings" ||
    path.startsWith("/api/v1/agent/contact-bindings/")
  );
}

const STUB_PIPELINE_SETTINGS: { settings: Record<string, unknown> } = {
  settings: {
    pipeline: {
      triage: {
        enabled: false,
        riskKeywords: [],
        llmClassifyEnabled: true,
        timeoutMs: 3000,
        allowDirectReply: false,
      },
      notes: { triage: "", human: "", fast: "", standard: "", gate: "" },
      defaultEmployeeKey: null,
      employeeRoutes: [],
    },
  },
};

const stubFetch: BridgeFetch = async (path: string, init?: RequestInit) => {
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/api/v1/auth/me" && method === "GET") {
    return json({
      user: {
        userId: "stub-admin",
        username: "consoleadmin",
        role: "admin",
        mustChangePassword: false,
        displayName: "Console Admin",
        tags: [],
      },
    });
  }
  if (path.startsWith("/api/v1/contacts") && method === "GET") {
    return json({ contacts: STUB_CONTACTS });
  }
  // 接待编排：扩展设置读 + 写（写回内存，让本页保存/回读在 dev 下闭环）。
  if (
    path ===
      "/api/v1/admin/solutions/weflow.customer-support/extensions/support-pipeline/settings" &&
    (method === "GET" || method === "PUT")
  ) {
    if (method === "PUT") {
      try {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          settings?: unknown;
        };
        if (body.settings) {
          STUB_PIPELINE_SETTINGS.settings = body.settings as Record<
            string,
            unknown
          >;
        }
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
    }
    return json(STUB_PIPELINE_SETTINGS);
  }
  if (path === "/api/v1/admin/model-settings" && method === "GET") {
    return json({
      settings: {
        textModel: { name: "stub-main-model" },
        triageModel: { name: "stub-triage-model" },
        fastModel: { name: "stub-fast-model" },
      },
    });
  }
  if (isAiEmployeesPath(path) && (method === "GET" || method === "PUT" || method === "POST" || method === "DELETE" || method === "PATCH")) {
    if (path === "/api/v1/agent/ai-employees" && method === "GET") {
      return json({ employees: [] });
    }
    if (path === "/api/v1/agent/workspace-default" && method === "GET") {
      return json({ setting: { defaultDefinitionId: null } });
    }
    if (path === "/api/v1/agent/contact-bindings" && method === "GET") {
      return json({ bindings: [] });
    }
    return json({ ok: true });
  }
  return fetch(path, init);
};

export function installDevStub(): void {
  setApiBridge(stubFetch);
  setAuthBridge(() => ({
    userId: "stub-admin",
    username: "consoleadmin",
    role: "admin",
    mustChangePassword: false,
    displayName: "Console Admin",
    tags: [],
  }));
}
