/**
 * 故障转移模型客户端（R2 模型网关运行时）。
 *
 * 实现平台 TextModel 契约：按槽位解析出的模型链依次尝试——主模型
 * 失败/超时自动切下一个；全链失败抛最后一次错误（fail-loud，由既有
 * turn 失败协调器接管降级）。
 *
 * 健康状态：每次调用结果（成功/失败）记录在进程内健康表，供设置页
 * 展示（模型是否可达、最近一次失败时间与原因）。健康状态不持久化——
 * 重启即重置，首个请求重新探测。
 *
 * 组合根（agent-worker）按槽位构建一次 FailoverTextModel；模型注册表
 * 变化经既有 15s 轮询（model-settings-hot 模式）重建链。
 */
import type { TextGenerationRequest } from "../../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../../../modules/model/contracts/text-model.js";

/** 链上单个模型条目（组合根从注册表解析后传入） */
export type FailoverLink = {
  /** 注册表 modelId（健康状态表的主键） */
  modelId: string;
  /** 展示名（审计/事件用） */
  displayName: string;
  /** 已构建的 OpenAI 兼容客户端 */
  client: TextModel;
};

export type ModelHealth = {
  modelId: string;
  displayName: string;
  /** 最近一次调用是否成功；从未调用 = null */
  lastSuccess: boolean | null;
  lastFailureReason: string | null;
  lastCheckedAt: number | null;
  /** 累计成功/失败计数（进程生命周期内） */
  successCount: number;
  failureCount: number;
};

/** 进程内健康表：modelId → 状态（跨链共享，模型唯一） */
const healthTable = new Map<string, ModelHealth>();

/** 读取全部模型健康状态（设置页只读展示） */
export function readModelHealth(): ModelHealth[] {
  return [...healthTable.values()].map((entry) => ({ ...entry }));
}

function recordHealth(
  modelId: string,
  displayName: string,
  success: boolean,
  reason?: string,
): void {
  const existing = healthTable.get(modelId) ?? {
    modelId,
    displayName,
    lastSuccess: null,
    lastFailureReason: null,
    lastCheckedAt: null,
    successCount: 0,
    failureCount: 0,
  };
  existing.lastSuccess = success;
  existing.lastCheckedAt = Date.now();
  if (success) {
    existing.successCount += 1;
    existing.lastFailureReason = null;
  } else {
    existing.failureCount += 1;
    existing.lastFailureReason = reason ?? "unknown";
  }
  healthTable.set(modelId, existing);
}

/** 测试钩子：清空健康表（vitest 隔离用） */
export function resetModelHealth(): void {
  healthTable.clear();
}

export class FailoverTextModel implements TextModel {
  #links: readonly FailoverLink[];

  constructor(links: readonly FailoverLink[]) {
    if (links.length === 0) {
      throw new Error("failover_chain_empty");
    }
    this.#links = links;
  }

  /** 当前链快照（组合根诊断用） */
  get links(): readonly FailoverLink[] {
    return this.#links;
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    let lastError: unknown;
    for (const link of this.#links) {
      try {
        const result = await link.client.generate(request);
        recordHealth(link.modelId, link.displayName, true);
        return result;
      } catch (error) {
        lastError = error;
        recordHealth(
          link.modelId,
          link.displayName,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("failover_chain_exhausted");
  }
}

/** 探测用最小静音 WAV（8kHz/16bit/单声道，100ms）；两端点协议通吃 */
function tinySilentWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * ASR 端点探测：文本补全探针对语音模型必然 400（MiMo 要求 input_audio、
 * 硅基流动 chat/completions 上无该模型），必须按注册条目协议发音频。
 * 只验证可达/认证/模型存在——空转写文本同样算探测成功。
 */
async function probeAsrConnection(
  endpoint: {
    baseUrl: string;
    apiKey?: string | undefined;
    displayName: string;
    protocol: "chat_inline" | "audio_transcriptions";
  },
  timeoutMs: number,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const startedAt = Date.now();
  const fail = (error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    const wav = tinySilentWav();
    let response: Response;
    if (endpoint.protocol === "audio_transcriptions") {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "probe.wav");
      form.append("model", endpoint.displayName);
      response = await fetch(
        `${endpoint.baseUrl.replace(/\/$/, "")}/audio/transcriptions`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.apiKey ?? ""}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } else {
      response = await fetch(
        `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.apiKey ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: endpoint.displayName,
            stream: false,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "input_audio",
                    input_audio: {
                      data: `data:audio/wav;base64,${wav.toString("base64")}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 16,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    }
    if (!response.ok) {
      const body = await response.text();
      return fail(
        new Error(
          `audio API returned ${String(response.status)}: ${body.slice(0, 500)}`,
        ),
      );
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return fail(error);
  }
}

/** 探测单模型的连接性：文本/视觉模型发一次最小 chat 补全，ASR 模型按协议发音频；只验证可达与认证。 */
export async function probeModelConnection(
  endpoint: {
    baseUrl: string;
    apiKey?: string | undefined;
    displayName: string;
    capabilities?: string[] | undefined;
    protocol?: "chat_inline" | "audio_transcriptions" | undefined;
  },
  timeoutMs: number,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const isAsr =
    endpoint.protocol === "audio_transcriptions" ||
    (endpoint.protocol === "chat_inline" &&
      (endpoint.capabilities ?? []).includes("asr"));
  if (isAsr) {
    return probeAsrConnection(
      {
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        displayName: endpoint.displayName,
        protocol: endpoint.protocol === "audio_transcriptions"
          ? "audio_transcriptions"
          : "chat_inline",
      },
      timeoutMs,
    );
  }
  const { OpenAiCompatibleClient } = await import(
    "../../../infrastructure/model_runtime/openai-compatible-client.js"
  );
  const client = new OpenAiCompatibleClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? "",
    model: endpoint.displayName,
    timeoutMs,
    maxTokens: 2_000,
  });
  const startedAt = Date.now();
  try {
    await client.complete(
      [{ role: "user", content: "ping" }],
      { maxTokens: 2_000 },
    );
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 记录一次人工探测结果（API 进程的「测试连接」端点调用）：
 * 与 worker 的自动健康记录写同一张进程内表，设置页徽章据此展示。
 * @returns 探测前的状态，便于 UI 提示「首次探测」
 */
export function probeModelAndRecord(
  displayName: string,
  modelId: string,
  endpoint: {
    baseUrl: string;
    apiKey?: string | undefined;
    displayName: string;
    capabilities?: string[] | undefined;
    protocol?: "chat_inline" | "audio_transcriptions" | undefined;
  },
  timeoutMs: number,
): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
  firstProbe: boolean;
}> {
  const existing = healthTable.get(modelId);
  const firstProbe = !existing || existing.lastSuccess === null;
  return probeModelConnection(endpoint, timeoutMs).then((result) => {
    recordHealth(
      modelId,
      displayName,
      result.ok,
      result.ok ? undefined : result.error,
    );
    return result.ok
      ? { ok: true, latencyMs: result.latencyMs, firstProbe }
      : { ok: false, error: result.error, firstProbe };
  });
}
