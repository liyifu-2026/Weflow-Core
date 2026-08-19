export interface SolutionOperationDTO {
  operationId: string;
  solutionId: string;
  type: string;
  state: string;
  planDigest: string | null;
  attempt: number;
  checkpoint: string | null;
  errorCode: string | null;
  actor: string;
  runnerId: string | null;
  createdAt: string;
}

export interface SolutionOperationPayloadDTO {
  operationId: string;
  manifestJson: Record<string, unknown>;
  lockJson: Record<string, unknown>;
  signatureJson: Record<string, unknown>;
}

export interface SecretAssignmentDTO {
  solutionId: string;
  slotName: string;
  refType: "env" | "file";
  refValue: string;
}

export interface SolutionRunnerClientOptions {
  baseUrl: string;
  token: string;
  runnerId: string;
  fetchImpl?: typeof fetch;
}

export class SolutionRunnerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SolutionRunnerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async listClaimable(): Promise<SolutionOperationDTO[]> {
    const data = await this.request<{ operations: SolutionOperationDTO[] }>(
      "/api/v1/runner/solution-operations",
      { method: "GET" },
    );
    return data.operations;
  }

  public async getPayload(
    operationId: string,
  ): Promise<SolutionOperationPayloadDTO> {
    const data = await this.request<{
      payload: SolutionOperationPayloadDTO;
    }>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/payload`,
      { method: "GET" },
    );
    return data.payload;
  }

  public async getSecretAssignments(
    solutionId: string,
  ): Promise<SecretAssignmentDTO[]> {
    const data = await this.request<{ assignments: SecretAssignmentDTO[] }>(
      `/api/v1/runner/solutions/${encodeURIComponent(solutionId)}/secrets`,
      { method: "GET" },
    );
    return data.assignments;
  }

  public async claim(
    operationId: string,
    leaseTtlMs?: number,
  ): Promise<SolutionOperationDTO> {
    return this.request<SolutionOperationDTO>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/claim`,
      {
        method: "POST",
        ...(leaseTtlMs === undefined
          ? {}
          : { body: JSON.stringify({ leaseTtlMs }) }),
      },
    );
  }

  public async start(operationId: string): Promise<SolutionOperationDTO> {
    return this.request<SolutionOperationDTO>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/start`,
      { method: "POST" },
    );
  }

  public async checkpoint(
    operationId: string,
    checkpoint: string,
  ): Promise<SolutionOperationDTO> {
    return this.request<SolutionOperationDTO>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/checkpoint`,
      {
        method: "POST",
        body: JSON.stringify({ checkpoint }),
      },
    );
  }

  public async complete(
    operationId: string,
    input: { solutionVersion?: string; checkpoint?: string } = {},
  ): Promise<SolutionOperationDTO> {
    return this.request<SolutionOperationDTO>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  public async fail(
    operationId: string,
    errorCode: string,
    checkpoint?: string,
  ): Promise<SolutionOperationDTO> {
    return this.request<SolutionOperationDTO>(
      `/api/v1/runner/solution-operations/${encodeURIComponent(operationId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify(
          checkpoint === undefined ? { errorCode } : { errorCode, checkpoint },
        ),
      },
    );
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        `solution runner request failed: ${response.status} ${body.error ?? response.statusText}`,
      );
    }
    return (await response.json()) as T;
  }
}
