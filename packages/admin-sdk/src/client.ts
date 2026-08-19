import {
  parseRuntimeStatus,
  parseSolutionDetail,
  parseSolutionOperation,
  parseSolutionSummary,
} from "./validation.js";
import type {
  AdminClient,
  CreateSolutionOperationInput,
} from "./types.js";

export interface AdminClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAdminClient(options: AdminClientOptions): AdminClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`admin request failed: ${response.status} ${response.statusText}`);
    }
    const body: unknown = await response.json();
    if (isRecord(body) && "error" in body) {
      const error = body.error;
      if (isRecord(error) && typeof error.message === "string") {
        throw new Error(error.message);
      }
      throw new Error("admin request failed");
    }
    const data = isRecord(body) && "data" in body ? body.data : body;
    return parse(data);
  }

  return {
    listSolutions: () =>
      request("/api/v1/admin/solutions", { method: "GET" }, (value) =>
        Array.isArray(value)
          ? value.map(parseSolutionSummary)
          : (() => {
              throw new Error("invalid admin response: expected array");
            })(),
      ),
    getSolution: (solutionId) =>
      request(
        `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}`,
        { method: "GET" },
        parseSolutionDetail,
      ),
    createSolutionOperation: (input: CreateSolutionOperationInput) =>
      request(
        "/api/v1/admin/solution-operations",
        { method: "POST", body: JSON.stringify(input) },
        parseSolutionOperation,
      ),
    getRuntimeStatus: () =>
      request("/api/v1/admin/runtime-status", { method: "GET" }, (value) =>
        Array.isArray(value)
          ? value.map(parseRuntimeStatus)
          : (() => {
              throw new Error("invalid admin response: expected array");
            })(),
      ),
  };
}
